import type { Rule, Scope } from 'eslint';

// Lesson 1 of the agents' notebook (/opt/agentes/modelos/licoes.md, PR #66): a FastifyReply is
// thenable, so an async helper that returns it hands its caller undefined once awaited, and the
// caller's `if (refused) return refused;` lets the request go on. eslint.config.js imports this file
// through Node's type stripping, so it holds erasable TypeScript only (types, no enums).
//
// Allowed: a reply returned where Fastify itself takes the value, followed through this file: the
// route handler or hook, and a helper (or a callback given to one) whose every call is returned
// straight to Fastify or discarded. Any other use of the value, or a use in another file, is
// reported: the safe shape is a helper that returns the reason and a handler that sends it.

type Node = Rule.Node;
// typescript-eslint's AST fields that ESTree's types do not name.
type TypeRef = { type: string; typeName?: { name?: string } };
type Typed = { typeAnnotation?: { typeAnnotation?: TypeRef } };
type Fn = Node & { async?: boolean; returnType?: { typeAnnotation?: TypeRef } };

/** Calls that register what Fastify itself calls: a route, a hook or an error handler. */
const REGISTERS = new Set([
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'head',
  'options',
  'all',
  'route',
  'addHook',
  'setErrorHandler',
  'setNotFoundHandler',
]);
/** Route option keys whose functions Fastify calls. */
const ROUTE_KEYS = new Set([
  'handler',
  'errorHandler',
  'onRequest',
  'preParsing',
  'preValidation',
  'preHandler',
  'preSerialization',
  'onSend',
  'onResponse',
  'onError',
  'onTimeout',
]);
/** The calls that end a reply chain (`reply.status(4xx).send(...)`, `reply.redirect(...)`). */
const ENDS = new Set(['send', 'redirect']);
/** Expressions that hand their operand's value on unchanged (or settle it, for `await`). */
const PASS = new Set([
  'AwaitExpression',
  'ChainExpression',
  'ConditionalExpression',
  'LogicalExpression',
  'SequenceExpression',
  'TSAsExpression',
  'TSNonNullExpression',
  'TSSatisfiesExpression',
]);

const MESSAGE =
  'A Fastify reply is thenable: returned from an async helper it turns into undefined when ' +
  'awaited and the caller goes on, so return the reason (or null) and let the route handler send ' +
  'the reply and return (lesson 1, /opt/agentes/modelos/licoes.md).';

const isFunction = (node: Node): node is Fn =>
  node.type === 'FunctionDeclaration' ||
  node.type === 'FunctionExpression' ||
  node.type === 'ArrowFunctionExpression';

const keyName = (node: Node): string | null => {
  if (node.type !== 'Property') return null;
  if (node.key.type === 'Identifier') return node.key.name;
  return node.key.type === 'Literal' && typeof node.key.value === 'string' ? node.key.value : null;
};

/** Fastify's own handler types (`preHandlerHookHandler`, `RouteHandlerMethod`...). */
const isHandlerType = (type: TypeRef | undefined) =>
  type?.type === 'TSTypeReference' &&
  /(HookHandler|RouteHandler|RouteHandlerMethod)$/.test(type.typeName?.name ?? '');

const returnsPromise = (fn: Fn): boolean => {
  if (fn.async) return true;
  const type = fn.returnType?.typeAnnotation;
  return type?.type === 'TSTypeReference' && type.typeName?.name === 'Promise';
};

/** Every node but the Program has a parent; ESLint's types allow null for the Program's. */
const up = (node: Node) => node.parent as Node;

const enclosingFunction = (node: Node): Fn | null => {
  for (let at: Node | null = node.parent; at; at = at.parent) if (isFunction(at)) return at;
  return null;
};

export const noAsyncReplyReturn: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow returning a Fastify reply from an async helper (lesson 1).' },
    messages: { asyncReply: MESSAGE },
    schema: [],
  },
  create(context) {
    const source = context.sourceCode;

    const variableOf = (name: Node & { name: string }): Scope.Variable | null => {
      for (let scope: Scope.Scope | null = source.getScope(name); scope; scope = scope.upper) {
        const variable = scope.set.get(name.name);
        if (variable) return variable;
      }
      return null;
    };

    /** The variable a function is declared as (`function f`, `const f = async () =>`). */
    const declaredAs = (fn: Fn): Scope.Variable | null => {
      const named = fn.type === 'FunctionDeclaration' ? fn : up(fn);
      if (named.type !== 'FunctionDeclaration' && named.type !== 'VariableDeclarator') return null;
      return source.scopeManager.getDeclaredVariables(named)[0] ?? null;
    };

    /** The uses of a variable's value (not its declaration, not `typeof f` in a type). */
    const usesOf = (variable: Scope.Variable) =>
      variable.references
        .filter((ref) => !ref.init && (up(ref.identifier as Node).type as string) !== 'TSTypeQuery')
        .map((ref) => ref.identifier as Node);

    /** `node` is called as `node(...)`: the call, else null. */
    const callOf = (node: Node): Node | null => {
      const parent = up(node);
      return parent.type === 'CallExpression' && parent.callee === node ? parent : null;
    };

    // Each question is asked once per node; a cycle (a recursive helper) answers no.
    const memo = new Map<string, Map<Node, boolean>>();
    const once = (kind: string, node: Node, answer: () => boolean): boolean => {
      let seen = memo.get(kind);
      if (!seen) memo.set(kind, (seen = new Map()));
      const known = seen.get(node);
      if (known !== undefined) return known;
      seen.set(node, false);
      const result = answer();
      seen.set(node, result);
      return result;
    };

    /** Climbs from `node` through expressions that pass its value on unchanged. */
    const outermost = (node: Node): Node => {
      let at = node;
      while (PASS.has(up(at).type)) {
        const parent = up(at);
        // A ternary's test and a sequence's leading items are read, not passed on.
        if (parent.type === 'ConditionalExpression' && parent.test === at) break;
        if (parent.type === 'SequenceExpression' && parent.expressions.at(-1) !== at) break;
        at = parent;
      }
      return at;
    };

    /** Is `fn` returned from by `node` (`return node`, or an arrow's expression body)? */
    const returnedFrom = (node: Node): Fn | null => {
      const parent = up(node);
      if (parent.type === 'ReturnStatement') return enclosingFunction(parent);
      return parent.type === 'ArrowFunctionExpression' && parent.body === node ? parent : null;
    };

    /** Will Fastify call the function `node` evaluates to (a route handler or hook)? */
    const calledByFastify = (node: Node): boolean =>
      once('called', node, () => {
        const at = outermost(node);
        const parent = up(at);
        if (parent.type === 'CallExpression' && parent.arguments.includes(at as never)) {
          const callee = parent.callee;
          if (
            callee.type === 'MemberExpression' &&
            callee.property.type === 'Identifier' &&
            REGISTERS.has(callee.property.name)
          )
            return true;
        }
        if (parent.type === 'Property' && parent.value === at)
          return ROUTE_KEYS.has(keyName(parent) ?? '');
        if (parent.type === 'ArrayExpression') {
          // `preHandler: [app.requireSession, async (request, reply) => ...]`
          const holder = up(parent);
          return holder.type === 'Property' && ROUTE_KEYS.has(keyName(holder) ?? '');
        }
        // A factory's result: `guarded(async (...) => ...)` given to `app.get`.
        const factory = returnedFrom(at);
        return factory !== null && everyCall(factory, calledByFastify);
      });

    /** Does every call of `fn` (by its name in this file) pass `test`? */
    const everyCall = (fn: Fn, test: (call: Node) => boolean): boolean => {
      const variable = declaredAs(fn);
      const uses = variable ? usesOf(variable) : [];
      return (
        uses.length > 0 &&
        uses.every((use) => {
          const call = callOf(use);
          return call !== null && test(call);
        })
      );
    };

    /** Does the value of `node` go straight back to Fastify, or nowhere? */
    const valueToFastify = (node: Node): boolean =>
      once('value', node, () => {
        const at = outermost(node);
        const parent = up(at);
        if (parent.type === 'ExpressionStatement') return true;
        if (parent.type === 'UnaryExpression' && parent.operator === 'void') return true;
        const fn = returnedFrom(at);
        return fn !== null && resultToFastify(fn);
      });

    /** Does what `fn` returns go straight back to Fastify, or nowhere? */
    const resultToFastify = (fn: Fn): boolean =>
      once('result', fn, () => {
        if (calledByFastify(fn)) return true;
        const variable = declaredAs(fn);
        if (variable) {
          const type = (variable.defs[0]?.name as Typed | undefined)?.typeAnnotation;
          if (isHandlerType(type?.typeAnnotation)) return true;
          const uses = usesOf(variable);
          return (
            uses.length > 0 &&
            uses.every((use) => {
              const call = callOf(use);
              return call ? valueToFastify(call) : calledByFastify(use);
            })
          );
        }
        return callbackToFastify(fn);
      });

    /** `fn` given to a helper of this file (`answer(reply, async () => ...)`): does the helper
     * only call it where the value goes straight back to Fastify? */
    const callbackToFastify = (fn: Fn): boolean => {
      const call = up(fn);
      if (call.type !== 'CallExpression' || call.callee.type !== 'Identifier') return false;
      const index = call.arguments.indexOf(fn as never);
      const helper = variableOf(call.callee as Node & { name: string })?.defs[0]?.node as
        Node | undefined;
      const body =
        helper?.type === 'VariableDeclarator' ? (helper.init as Node | null) : (helper ?? null);
      if (!body || !isFunction(body)) return false;
      const param = (body as Fn & { params: Node[] }).params[index];
      if (param?.type !== 'Identifier') return false;
      const variable = source.scopeManager
        .getDeclaredVariables(body)
        .find((candidate) => candidate.defs[0]?.name === param);
      const uses = variable ? usesOf(variable) : [];
      return (
        uses.length > 0 &&
        uses.every((use) => {
          const inner = callOf(use);
          return inner !== null && valueToFastify(inner);
        })
      );
    };

    /** Is this name a Fastify reply: called `reply`, or a parameter typed `FastifyReply`? */
    const isReplyName = (node: Node & { name: string }): boolean => {
      if (node.name === 'reply') return true;
      const def = variableOf(node)?.defs[0];
      const type = (def?.name as Typed | undefined)?.typeAnnotation?.typeAnnotation;
      return (
        def?.type === 'Parameter' &&
        type?.type === 'TSTypeReference' &&
        type.typeName?.name === 'FastifyReply'
      );
    };

    /** Can the value of `node` be the reply itself? */
    const isReply = (node: Node): boolean => {
      if (node.type === 'Identifier') return isReplyName(node);
      if (node.type === 'ConditionalExpression')
        return isReply(node.consequent as Node) || isReply(node.alternate as Node);
      if (node.type === 'LogicalExpression')
        return isReply(node.left as Node) || isReply(node.right as Node);
      if (node.type === 'SequenceExpression') return isReply(node.expressions.at(-1) as Node);
      if (node.type === 'AwaitExpression') return isReply(node.argument as Node);
      if (node.type === 'ChainExpression') return isReply(node.expression as Node);
      const inner = (node as Node & { expression?: Node }).expression;
      if (PASS.has(node.type) && inner) return isReply(inner);
      if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') return false;
      const { property } = node.callee;
      if (property.type !== 'Identifier' || !ENDS.has(property.name)) return false;
      // Down the chain to its root: `reply.status(429).header(...).send(...)`.
      let at = node.callee.object as Node;
      while (at.type === 'CallExpression' || at.type === 'MemberExpression')
        at = (at.type === 'CallExpression' ? at.callee : at.object) as Node;
      return at.type === 'Identifier' && isReplyName(at);
    };

    const check = (fn: Fn, value: Node | null | undefined) => {
      if (!value || !returnsPromise(fn) || !isReply(value) || resultToFastify(fn)) return;
      context.report({ node: value, messageId: 'asyncReply' });
    };

    return {
      ReturnStatement(node) {
        const fn = enclosingFunction(node as Node);
        if (fn) check(fn, node.argument as Node | null);
      },
      ArrowFunctionExpression(node) {
        if (node.body.type !== 'BlockStatement') check(node as Fn, node.body as Node);
      },
    };
  },
};
