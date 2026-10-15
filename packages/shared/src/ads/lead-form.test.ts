import { describe, expect, it } from 'vitest';
import { extractLeadFields, leadFieldOfQuestion } from '../lead-fields.js';
import {
  LEAD_FORM_FIELD_OF_KEY,
  LEAD_FORM_QUALIFIER_META_KEY,
  LEAD_FORM_QUALIFIER_SUGGESTION,
  LEAD_FORM_QUESTIONS,
  LEAD_FORM_THANK_YOU_DEFAULT,
  leadFormFingerprint,
  leadFormQuestionsInOrder,
  leadFormSchema,
  siteFormSpecSchema,
  type LeadFormInput,
  type SiteFormSpecInput,
} from './lead-form.js';

const valid: LeadFormInput = {
  qualifier: null,
  privacyPolicyUrl: 'https://wingscompany.com.br/politica-de-privacidade/',
  thankYou: { ...LEAD_FORM_THANK_YOU_DEFAULT, buttonUrl: 'https://wingscompany.com.br/' },
  funnel: { pipeline: 'formatacao', brand: null, clientId: null },
};

describe('the standard form maps onto the lead fields', () => {
  it('every question label maps to its field by text', () => {
    for (const question of LEAD_FORM_QUESTIONS) {
      expect(leadFieldOfQuestion(question.label), question.label).toBe(
        LEAD_FORM_FIELD_OF_KEY[question.field],
      );
    }
  });

  it('every Meta key maps to its field, the way the intake reads field_data', () => {
    for (const question of LEAD_FORM_QUESTIONS) {
      expect(leadFieldOfQuestion(question.metaKey), question.metaKey).toBe(
        LEAD_FORM_FIELD_OF_KEY[question.field],
      );
    }
  });

  it('answers keyed by Meta key fill the five fields and leave the qualifier as an answer', () => {
    const fields = extractLeadFields([
      { question: LEAD_FORM_QUALIFIER_META_KEY, answer: '2 a 5' },
      ...LEAD_FORM_QUESTIONS.map((question) => ({
        question: question.metaKey,
        answer: question.sample,
      })),
    ]);
    expect(Object.keys(fields).sort()).toEqual(
      ['companyName', 'instagram', 'name', 'website', 'whatsapp'].sort(),
    );
    // The key, not the wording, is what the intake maps by: "…a sua empresa…"
    // in the question would otherwise make the answer the company's name.
    expect(leadFieldOfQuestion(LEAD_FORM_QUALIFIER_META_KEY)).toBeNull();
    expect(fields.companyName).toBe('Padaria Exemplo');
  });
});

describe('leadFormSchema', () => {
  it('accepts the default form with the qualifier off', () => {
    const parsed = leadFormSchema.parse(valid);
    expect(parsed.qualifier).toBeNull();
    expect(leadFormQuestionsInOrder(parsed)).toHaveLength(5);
  });

  it('puts the qualifier first when it is on', () => {
    const parsed = leadFormSchema.parse({
      ...valid,
      qualifier: {
        ...LEAD_FORM_QUALIFIER_SUGGESTION,
        options: [...LEAD_FORM_QUALIFIER_SUGGESTION.options],
      },
    });
    const order = leadFormQuestionsInOrder(parsed);
    expect(order).toHaveLength(6);
    expect(order[0]).toMatchObject({
      kind: 'qualifier',
      options: ['1', '2 a 5', '6 a 20', 'Mais de 20'],
    });
  });

  it('refuses a qualifier with one option or repeated options', () => {
    expect(
      leadFormSchema.safeParse({
        ...valid,
        qualifier: { question: 'Quantas lojas?', options: ['1'] },
      }).success,
    ).toBe(false);
    expect(
      leadFormSchema.safeParse({
        ...valid,
        qualifier: { question: 'Quantas lojas?', options: ['1', '1'] },
      }).success,
    ).toBe(false);
  });

  it('refuses an http privacy policy and Expansão without a brand', () => {
    expect(
      leadFormSchema.safeParse({ ...valid, privacyPolicyUrl: 'http://wingscompany.com.br/p' })
        .success,
    ).toBe(false);
    const result = leadFormSchema.safeParse({
      ...valid,
      funnel: { pipeline: 'expansao', brand: null, clientId: null },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join('.'))).toContain('funnel.brand');
    }
  });

  it('fingerprints the same form the same way whatever the funnel', () => {
    const a = leadFormSchema.parse(valid);
    const b = leadFormSchema.parse({
      ...valid,
      funnel: { pipeline: 'expansao', brand: 'Marca X', clientId: null },
    });
    expect(leadFormFingerprint(a)).toBe(leadFormFingerprint(b));
    const c = leadFormSchema.parse({ ...valid, thankYou: { ...valid.thankYou, title: 'Outro' } });
    expect(leadFormFingerprint(c)).not.toBe(leadFormFingerprint(a));
  });
});

describe('siteFormSpecSchema (the site page only)', () => {
  const spec: SiteFormSpecInput = {
    qualifier: {
      question: 'O que você procura?',
      options: ['Formatar a empresa', 'Expandir a rede', 'Ainda não sei'],
    },
    qualifierValues: [
      { value: 'formatacao', option: 'Formatar a empresa' },
      { value: 'expansao', option: 'Expandir a rede', pipeline: 'expansao' },
      { value: 'nao-sei', option: 'Ainda não sei', pipeline: null },
    ],
    requiredFields: ['email', 'instagram', 'qualifierAnswer'],
    privacyPolicyUrl: 'https://wingscompany.com.br/politica-de-privacidade/',
    thankYou: { ...LEAD_FORM_THANK_YOU_DEFAULT, buttonUrl: 'https://wingscompany.com.br/' },
  };
  const issuesOf = (input: unknown) => {
    const result = siteFormSpecSchema.safeParse(input);
    return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
  };

  it('keeps the codes, the funnels they name and the required fields', () => {
    const parsed = siteFormSpecSchema.parse(spec);
    expect(parsed.requiredFields).toEqual(['email', 'instagram', 'qualifierAnswer']);
    expect(parsed.qualifierValues?.[0]).toEqual({
      value: 'formatacao',
      option: 'Formatar a empresa',
    });
    expect(parsed.qualifierValues?.[0]).not.toHaveProperty('pipeline');
    expect(parsed.qualifierValues?.[2]?.pipeline).toBeNull();
  });

  it('an older spec (no codes, nothing required) still parses as it was', () => {
    const parsed = siteFormSpecSchema.parse({
      privacyPolicyUrl: spec.privacyPolicyUrl,
      thankYou: spec.thankYou,
    });
    expect(parsed.qualifier).toBeNull();
    expect(parsed.requiredFields).toBeUndefined();
    expect(parsed.qualifierValues).toBeUndefined();
  });

  it('refuses codes or a required answer without the question', () => {
    expect(issuesOf({ ...spec, qualifier: null })).toEqual(
      expect.arrayContaining(['requiredFields', 'qualifierValues']),
    );
  });

  it('refuses a repeated code, an option the question does not have and a missing option', () => {
    const [first, second, third] = spec.qualifierValues!;
    expect(
      issuesOf({ ...spec, qualifierValues: [first, { ...second!, value: 'formatacao' }, third] }),
    ).toEqual(['qualifierValues.1.value']);
    expect(
      issuesOf({ ...spec, qualifierValues: [first, { ...second!, option: 'Outra' }, third] }),
    ).toEqual(['qualifierValues.1.option']);
    expect(
      issuesOf({ ...spec, qualifierValues: [first, { ...second!, option: first!.option }, third] }),
    ).toEqual(['qualifierValues.1.option']);
    expect(issuesOf({ ...spec, qualifierValues: [first, second] })).toEqual(['qualifierValues']);
    expect(
      issuesOf({ ...spec, qualifierValues: [{ ...first!, value: 'Com Espaço' }, second, third] }),
    ).toEqual(['qualifierValues.0.value']);
    expect(
      issuesOf({ ...spec, qualifierValues: [{ ...first!, pipeline: 'outro' }, second, third] }),
    ).toEqual(['qualifierValues.0.pipeline']);
  });

  it('refuses an unknown or repeated required field', () => {
    expect(issuesOf({ ...spec, requiredFields: ['cpf'] })).toEqual(['requiredFields.0']);
    expect(issuesOf({ ...spec, requiredFields: ['email', 'email'] })).toEqual(['requiredFields']);
  });

  it('keeps the consent line the page shows, trimmed, from 10 to 300 characters', () => {
    const line = 'Li a Política de Privacidade e autorizo o contato.';
    expect(siteFormSpecSchema.parse({ ...spec, consentText: `  ${line}  ` }).consentText).toBe(
      line,
    );
    expect(siteFormSpecSchema.parse(spec)).not.toHaveProperty('consentText');
    expect(issuesOf({ ...spec, consentText: 'Aceito.' })).toEqual(['consentText']);
    expect(issuesOf({ ...spec, consentText: `   ${'a'.repeat(9)}   ` })).toEqual(['consentText']);
    expect(issuesOf({ ...spec, consentText: 'a'.repeat(300) })).toEqual([]);
    expect(issuesOf({ ...spec, consentText: 'a'.repeat(301) })).toEqual(['consentText']);
  });

  it("the Meta form never takes the site page's options", () => {
    const parsed = leadFormSchema.parse({
      ...valid,
      requiredFields: ['email'],
      qualifierValues: spec.qualifierValues,
      consentText: 'Li a Política de Privacidade e autorizo o contato.',
    });
    expect(parsed).not.toHaveProperty('requiredFields');
    expect(parsed).not.toHaveProperty('qualifierValues');
    expect(parsed).not.toHaveProperty('consentText');
  });
});
