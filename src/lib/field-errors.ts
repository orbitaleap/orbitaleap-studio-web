/**
 * Inline validation messages under each field.
 *
 * The fields already turn red on :user-invalid, and the browser shows a
 * native tooltip — but only on a submit attempt, and only on the first
 * offending field. So someone typing a malformed email saw a red line and no
 * explanation until they pressed the button, and then only for one field at
 * a time.
 *
 * This says what is wrong, where it is wrong, as soon as they leave the
 * field. It is a courtesy layer: the server validates the same shapes
 * independently, because a direct post never runs any of this.
 */

type Lang = 'es' | 'en';

const COPY: Record<Lang, Record<string, string>> = {
  es: {
    valueMissing: 'Este campo es obligatorio.',
    typeMismatch: 'Revisa el formato.',
    tooShort: 'Añade un poco más de detalle.',
    patternMismatch: 'Revisa el formato.',
    default: 'Revisa este campo.',
  },
  en: {
    valueMissing: 'This field is required.',
    typeMismatch: 'Check the format.',
    tooShort: 'A little more detail, please.',
    patternMismatch: 'Check the format.',
    default: 'Check this field.',
  },
};

type Field = HTMLInputElement | HTMLTextAreaElement;

function messageFor(field: Field, lang: Lang): string {
  const t = COPY[lang];
  const v = field.validity;

  // `title` carries the field-specific explanation ("Introduce un email
  // válido, por ejemplo nombre@empresa.com"). Prefer it over the generic
  // string whenever the failure is about shape, since it names the fix.
  if ((v.patternMismatch || v.typeMismatch) && field.title) return field.title;

  if (v.valueMissing) return t.valueMissing;
  if (v.tooShort) {
    const left = Math.max(0, field.minLength - field.value.length);
    return lang === 'es'
      ? `Falta${left === 1 ? '' : 'n'} ${left} car\u00e1cter${left === 1 ? '' : 'es'}.`
      : `${left} character${left === 1 ? '' : 's'} to go.`;
  }
  if (v.typeMismatch) return t.typeMismatch;
  if (v.patternMismatch) return t.patternMismatch;
  return field.validationMessage || t.default;
}

/**
 * @param fieldSelector the input class this site uses — `.ol-field` on the
 *        studio forms, `.contact-form__input` on orbitaleap.com.
 */
export function wireFieldErrors(fieldSelector: string, errorClass = 'ol-field-error') {
  const lang: Lang = (document.documentElement.lang || 'es').startsWith('en') ? 'en' : 'es';

  document.querySelectorAll<Field>(fieldSelector).forEach((field) => {
    if (field.dataset.errWired) return;
    field.dataset.errWired = '1';

    const note = document.createElement('p');
    note.className = errorClass;
    note.hidden = true;
    // Announced when it appears, so it is not a sighted-only affordance.
    note.setAttribute('aria-live', 'polite');
    field.insertAdjacentElement('afterend', note);

    const check = () => {
      if (field.validity.valid) {
        note.hidden = true;
        field.removeAttribute('aria-invalid');
        return;
      }
      note.textContent = messageFor(field, lang);
      note.hidden = false;
      field.setAttribute('aria-invalid', 'true');
    };

    // On blur, not on every keystroke: flagging an email as malformed while
    // it is still being typed is correct and useless.
    field.addEventListener('blur', check);
    // Once flagged, update live so the message clears the moment it is fixed.
    field.addEventListener('input', () => { if (!note.hidden) check(); });

    // The browser fires `invalid` on every offending control when it refuses
    // to submit — and it refuses *before* the submit event, so a submit
    // listener alone never runs in the case that matters most: someone who
    // filled a field wrongly and pressed the button without leaving it.
    field.addEventListener('invalid', check);
    field.form?.addEventListener('submit', check);
  });
}
