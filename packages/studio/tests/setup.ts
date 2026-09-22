/**
 * The upstream suite is written against Jest. Everything it uses has a Vitest
 * twin; this file wires the names so the tests stay diffable against the SDK.
 * `jest.mock(...)` calls are rewritten to `vi.mock(...)` in the test files
 * themselves, because Vitest hoists mocks by name.
 *
 * Jest lets `new` be used on a mock whose implementation is an arrow function;
 * Vitest 5 does not. `vi.fn` is wrapped so every implementation is a plain
 * function, which behaves the same when called and can also be constructed.
 */
import { vi } from 'vitest';

type AnyFn = (...args: unknown[]) => unknown;

function constructible(impl?: AnyFn): AnyFn | undefined {
  if (!impl) return undefined;
  return function (this: unknown, ...args: unknown[]) {
    return impl.apply(this, args);
  };
}

const realFn = vi.fn;
const wrappedFn = ((impl?: AnyFn) => {
  const mock = realFn(constructible(impl) as never);
  const mockImplementation = mock.mockImplementation.bind(mock);
  const mockImplementationOnce = mock.mockImplementationOnce.bind(mock);
  mock.mockImplementation = ((next: AnyFn) => mockImplementation(constructible(next) as never)) as never;
  mock.mockImplementationOnce = ((next: AnyFn) =>
    mockImplementationOnce(constructible(next) as never)) as never;
  return mock;
}) as typeof vi.fn;

vi.fn = wrappedFn;

Object.assign(globalThis, { jest: vi });
