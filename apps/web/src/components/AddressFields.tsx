import type { AddressInput } from '../api/types';
import { Field } from './ui';

export const emptyAddress = (name = ''): AddressInput => ({
  name,
  line1: '',
  line2: '',
  city: '',
  region: '',
  postalCode: '',
  country: 'US',
});

/** Controlled address inputs, shared by "add customer" and the address dialogs. */
export function AddressFields({ value, onChange }: { value: AddressInput; onChange: (v: AddressInput) => void }) {
  const set = (k: keyof AddressInput) => (e: React.ChangeEvent<HTMLInputElement>) => onChange({ ...value, [k]: e.target.value });
  return (
    <div className="form-grid">
      <div className="span-2">
        <Field label="Recipient name">{(id) => <input id={id} autoComplete="name" value={value.name} onChange={set('name')} required />}</Field>
      </div>
      <div className="span-2">
        <Field label="Street address">
          {(id) => <input id={id} autoComplete="address-line1" value={value.line1} onChange={set('line1')} required />}
        </Field>
      </div>
      <div className="span-2">
        <Field label="Apartment, suite, etc. (optional)">
          {(id) => <input id={id} autoComplete="address-line2" value={value.line2 ?? ''} onChange={set('line2')} />}
        </Field>
      </div>
      <Field label="City">{(id) => <input id={id} autoComplete="address-level2" value={value.city} onChange={set('city')} required />}</Field>
      <Field label="State / region">
        {(id) => <input id={id} autoComplete="address-level1" value={value.region} onChange={set('region')} required />}
      </Field>
      <Field label="Postal code">
        {(id) => <input id={id} autoComplete="postal-code" value={value.postalCode} onChange={set('postalCode')} required />}
      </Field>
      <Field label="Country code" hint="Two letters, e.g. US">
        {(id) => (
          <input
            id={id}
            autoComplete="country"
            value={value.country}
            onChange={(e) => onChange({ ...value, country: e.target.value.toUpperCase() })}
            required
            minLength={2}
            maxLength={2}
            pattern="[A-Za-z]{2}"
          />
        )}
      </Field>
    </div>
  );
}

/** Strips the empty optional line so the API stores null rather than "". */
export const cleanAddress = (a: AddressInput): AddressInput => ({ ...a, line2: a.line2?.trim() ? a.line2 : null });
