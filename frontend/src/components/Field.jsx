/**
 * A labelled form field with an optional hint and error message.
 *
 * Label, hint and error are tied to the input with for / aria-describedby, so
 * a screen reader announces all three, and an invalid field is marked with
 * aria-invalid as well as visually.
 */

/**
 * @param {object} props
 * @param {string} props.id                unique id of the input
 * @param {string} props.label
 * @param {string} [props.hint]            help text under the label
 * @param {string} [props.error]           message shown when the value is not acceptable
 * @param {"input"|"textarea"|"select"} [props.as] which element to render (default: input)
 * @param {string} props.value
 * @param {(value: string) => void} props.onChange receives the new text
 * @param {string} [props.className]       extra class on the wrapper, for grid placement
 * @param {import("react").ReactNode} [props.children] the <option>s of a select
 * Every other prop (type, inputMode, max, disabled, ...) is passed to the element.
 */
export function Field({ id, label, hint, error, as = "input", value, onChange, className = "", children, ...rest }) {
  const Element = as;
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={`field ${className}`}>
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      {hint ? (
        <span id={`${id}-hint`} className="field__hint">
          {hint}
        </span>
      ) : null}
      <Element
        id={id}
        className={as}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error ? "true" : undefined}
        aria-describedby={describedBy}
        {...rest}
      >
        {children}
      </Element>
      {error ? (
        <span id={`${id}-error`} className="field__error">
          {error}
        </span>
      ) : null}
    </div>
  );
}
