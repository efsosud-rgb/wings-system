import { describe, expect, it } from 'vitest';
import {
  declaresNone,
  extractLeadFields,
  leadFieldOfQuestion,
  normalizeInstagram,
  normalizeWebsite,
  whatsappCheck,
} from './lead-fields.js';

const AT = new Date('2026-10-06T15:00:00Z');

describe('leadFieldOfQuestion', () => {
  it.each([
    ['Qual é o seu nome?', 'name'],
    ['Nome completo', 'name'],
    ['full_name', 'name'],
    ['Nome da empresa', 'companyName'],
    ['Qual o nome do seu negócio?', 'companyName'],
    ['company_name', 'companyName'],
    ['@ do Instagram da empresa', 'instagram'],
    ['Instagram', 'instagram'],
    ['Site da empresa', 'website'],
    ['website', 'website'],
    ['WhatsApp com DDD', 'whatsapp'],
    ['phone_number', 'whatsapp'],
    ['Telefone celular', 'whatsapp'],
    ['CNPJ (se tiver)', 'cnpj'],
    ['Qual seu faturamento mensal?', null],
    ['E-mail', null],
    ['WhatsApp da empresa', 'whatsapp'],
    ['Telefone da empresa', 'whatsapp'],
    ['Número para contato', 'whatsapp'],
    ['Melhor horário para contato', null],
    ['Quantos funcionários a empresa tem?', null],
    ['Empresa', 'companyName'],
    ['Qual é a sua empresa?', 'companyName'],
    ['Nome da sua marca', 'companyName'],
    ['Segmento da empresa', null],
  ])('%s → %s', (question, field) => {
    expect(leadFieldOfQuestion(question)).toBe(field);
  });
});

describe('declaresNone', () => {
  it.each([
    ['não tenho', true],
    ['Não tenho site', true],
    ['nenhum', true],
    ['-', true],
    ['N/A', true],
    ['ainda não tenho', true],
    ['@empresa.exemplo', false],
    ['empresa-exemplo.com.br', false],
  ])('%s → %s', (value, none) => {
    expect(declaresNone(value)).toBe(none);
  });
});

describe('extractLeadFields', () => {
  it('takes the first non-empty answer of each field', () => {
    expect(
      extractLeadFields([
        { question: 'Nome', answer: '  ' },
        { question: 'Nome completo', answer: 'Pessoa Exemplo' },
        { question: 'Nome da empresa', answer: 'Empresa Exemplo' },
        { question: 'Instagram', answer: '@empresa.exemplo' },
        { question: 'Faturamento', answer: '50 mil' },
      ]),
    ).toEqual({
      name: 'Pessoa Exemplo',
      companyName: 'Empresa Exemplo',
      instagram: '@empresa.exemplo',
    });
  });

  it('skips a WhatsApp answer without a number, so the one with the number fills it', () => {
    expect(
      extractLeadFields([
        { question: 'Contato preferido (WhatsApp ou e-mail)', answer: 'WhatsApp' },
        { question: 'WhatsApp com DDD', answer: '(11) 98888-7777' },
      ]),
    ).toEqual({ whatsapp: '(11) 98888-7777' });
  });
});

describe('normalisation', () => {
  it('reads Instagram handles from @, plain text and links', () => {
    expect(normalizeInstagram('@Empresa.Exemplo')).toBe('empresa.exemplo');
    expect(normalizeInstagram('https://www.instagram.com/empresa_exemplo/?hl=pt')).toBe(
      'empresa_exemplo',
    );
    expect(normalizeInstagram('não tenho')).toBeNull();
    expect(normalizeInstagram('a..b')).toBeNull();
  });

  it('reads public web addresses and refuses the rest', () => {
    expect(normalizeWebsite('empresa-exemplo.com.br')).toBe('https://empresa-exemplo.com.br/');
    expect(normalizeWebsite('http://www.exemplo.com/loja')).toBe('http://www.exemplo.com/loja');
    expect(normalizeWebsite('instagram.com/exemplo')).toBeNull();
    expect(normalizeWebsite('192.168.0.1')).toBeNull();
    expect(normalizeWebsite('não tenho site')).toBeNull();
    expect(normalizeWebsite('ftp://exemplo.com')).toBeNull();
  });
});

describe('whatsappCheck', () => {
  it.each([
    ['+55 (21) 98888-7777', 'confere', null],
    ['21988887777', 'confere', null],
    ['021 98888-7777', 'confere', null],
    ['(20) 98888-7777', 'nao_confere', 'DDD inexistente'],
    ['(21) 3888-7777', 'nao_confere', 'Número fixo: o WhatsApp precisa de celular'],
    ['(21) 88888-7777', 'nao_confere', 'Celular do Brasil começa com 9 depois do DDD'],
    ['98888', 'nao_confere', 'Quantidade de dígitos não é de um número do Brasil'],
    [
      '+351 912 345 678',
      'nao_verificado',
      'Número de fora do Brasil: só números do Brasil são conferidos',
    ],
    ['', 'nao_verificado', 'O formulário não trouxe WhatsApp'],
  ])('%s → %s', (value, status, reason) => {
    expect(whatsappCheck(value, AT)).toEqual({ status, reason, checkedAt: AT.toISOString() });
  });
});
