import { BRAZIL_UFS, formatCep, type BrazilUf, type ClientAddress } from '@wings/shared';
import { useEffect, useState } from 'react';
import { ApiError } from '../../api/client.js';
import { useCepLookup } from '../../api/clients.js';
import { Button, Field, Input, Select } from '../ui.js';

/**
 * The inputs of the client record. Each holds the typed value the API takes
 * (centavos, a percent, a yyyy-mm-dd day, null for empty) and shows it the way
 * people write it in Brazil.
 */

type Setter<T> = (value: T) => void;

export function TextField({
  label,
  value,
  onChange,
  hint,
  disabled,
  type = 'text',
  multiline,
  placeholder,
}: {
  label: string;
  value: string | null;
  onChange: Setter<string | null>;
  hint?: string;
  disabled?: boolean;
  type?: 'text' | 'email' | 'date' | 'tel' | 'url';
  multiline?: boolean;
  placeholder?: string;
}) {
  const set = (text: string) => onChange(text === '' ? null : text);
  return (
    <Field label={label} hint={hint}>
      {multiline ? (
        <textarea
          className="control"
          rows={4}
          value={value ?? ''}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(event) => set(event.target.value)}
        />
      ) : (
        <Input
          type={type}
          value={value ?? ''}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(event) => set(event.target.value)}
        />
      )}
    </Field>
  );
}

/** "1.234,56" <-> 123456 centavos. */
export const centsToText = (cents: number | null) =>
  cents === null ? '' : (cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function textToNumber(text: string): number | null {
  const clean = text.replace(/[^\d,.-]/g, '');
  if (!clean) return null;
  // "1.234,56" and "1234,56" are Brazilian; "1234.56" is accepted too.
  const normalized = clean.includes(',') ? clean.replace(/\./g, '').replace(',', '.') : clean;
  const value = Number.parseFloat(normalized);
  return Number.isFinite(value) ? value : null;
}

/** A number typed freely and committed on blur, so "1.2" is not reformatted mid-typing. */
function NumericField({
  label,
  value,
  onChange,
  toText,
  fromText,
  hint,
  disabled,
  prefix,
  suffix,
}: {
  label: string;
  value: number | null;
  onChange: Setter<number | null>;
  toText: (value: number | null) => string;
  fromText: (text: string) => number | null;
  hint?: string;
  disabled?: boolean;
  prefix?: string;
  suffix?: string;
}) {
  const [text, setText] = useState(toText(value));
  // Follows the value only when it changed from outside (a lookup, a reload),
  // never while the text being typed already means it.
  useEffect(() => {
    setText((current) => (fromText(current) === value ? current : toText(value)));
  }, [value, toText, fromText]);
  return (
    <Field label={label} hint={hint}>
      <div className="input-affix">
        {prefix && <span className="input-affix-text">{prefix}</span>}
        <Input
          inputMode="decimal"
          value={text}
          disabled={disabled}
          onChange={(event) => {
            setText(event.target.value);
            onChange(fromText(event.target.value));
          }}
          onBlur={() => setText(toText(fromText(text)))}
        />
        {suffix && <span className="input-affix-text">{suffix}</span>}
      </div>
    </Field>
  );
}

const moneyFromText = (text: string) => {
  const value = textToNumber(text);
  return value === null ? null : Math.round(Math.max(0, value) * 100);
};
const percentToText = (value: number | null) =>
  value === null ? '' : value.toLocaleString('pt-BR', { maximumFractionDigits: 2 });
const percentFromText = (text: string) => {
  const value = textToNumber(text);
  return value === null ? null : Math.min(100, Math.max(0, Math.round(value * 100) / 100));
};
const intToText = (value: number | null) => (value === null ? '' : String(value));
const intFromText = (text: string) => {
  const digits = text.replace(/\D/g, '');
  return digits ? Number.parseInt(digits, 10) : null;
};

export function MoneyField(props: { label: string; value: number | null; onChange: Setter<number | null>; hint?: string; disabled?: boolean }) {
  return <NumericField {...props} prefix="R$" toText={centsToText} fromText={moneyFromText} />;
}

export function PercentField(props: { label: string; value: number | null; onChange: Setter<number | null>; hint?: string; disabled?: boolean }) {
  return <NumericField {...props} suffix="%" toText={percentToText} fromText={percentFromText} />;
}

export function IntegerField(props: {
  label: string;
  value: number | null;
  onChange: Setter<number | null>;
  hint?: string;
  disabled?: boolean;
  suffix?: string;
}) {
  return <NumericField {...props} toText={intToText} fromText={intFromText} />;
}

export function ChoiceField<T extends string>({
  label,
  value,
  onChange,
  options,
  labels,
  hint,
  disabled,
}: {
  label: string;
  value: T | null;
  onChange: Setter<T | null>;
  options: readonly T[];
  labels: Record<T, string>;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <Field label={label} hint={hint}>
      <Select
        value={value ?? ''}
        disabled={disabled}
        onChange={(event) => onChange((event.target.value || null) as T | null)}
      >
        <option value="">—</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {labels[option]}
          </option>
        ))}
      </Select>
    </Field>
  );
}

/** An address, filled from the CEP (BrasilAPI, then ViaCEP) and then by hand. */
export function AddressFields({
  value,
  onChange,
  disabled,
}: {
  value: ClientAddress;
  onChange: Setter<ClientAddress>;
  disabled?: boolean;
}) {
  const lookup = useCepLookup();
  const set = (patch: Partial<ClientAddress>) => onChange({ ...value, ...patch });
  const cepDigits = (value.cep ?? '').replace(/\D/g, '');
  return (
    <div className="grid-3">
      <Field
        label="CEP"
        hint={lookup.isSuccess ? 'Endereço preenchido pelo CEP. Confira e complete o número.' : undefined}
        error={
          lookup.error
            ? lookup.error instanceof ApiError
              ? lookup.error.message
              : 'Não foi possível consultar o CEP.'
            : undefined
        }
      >
        <div className="input-row">
          <Input
            value={value.cep ? formatCep(value.cep) : ''}
            disabled={disabled}
            placeholder="00000-000"
            inputMode="numeric"
            onChange={(event) => {
              lookup.reset();
              set({ cep: event.target.value.replace(/\D/g, '').slice(0, 8) || null });
            }}
          />
          <Button
            type="button"
            variant="ghost"
            disabled={disabled || cepDigits.length !== 8 || lookup.isPending}
            onClick={() =>
              lookup.mutate(cepDigits, {
                onSuccess: (found) =>
                  onChange({
                    ...value,
                    cep: found.address.cep ?? value.cep,
                    street: found.address.street ?? value.street,
                    district: found.address.district ?? value.district,
                    city: found.address.city ?? value.city,
                    state: found.address.state ?? value.state,
                  }),
              })
            }
          >
            {lookup.isPending ? 'Buscando…' : 'Buscar CEP'}
          </Button>
        </div>
      </Field>
      <TextField label="Logradouro" value={value.street} onChange={(street) => set({ street })} disabled={disabled} />
      <TextField label="Número" value={value.number} onChange={(number) => set({ number })} disabled={disabled} />
      <TextField
        label="Complemento"
        value={value.complement}
        onChange={(complement) => set({ complement })}
        disabled={disabled}
      />
      <TextField label="Bairro" value={value.district} onChange={(district) => set({ district })} disabled={disabled} />
      <TextField label="Cidade" value={value.city} onChange={(city) => set({ city })} disabled={disabled} />
      <Field label="UF">
        <Select
          value={value.state ?? ''}
          disabled={disabled}
          onChange={(event) => set({ state: (event.target.value || null) as BrazilUf | null })}
        >
          <option value="">—</option>
          {BRAZIL_UFS.map((uf) => (
            <option key={uf} value={uf}>
              {uf}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  );
}
