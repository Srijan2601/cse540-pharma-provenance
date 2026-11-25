/**
 * The few icons the app uses, drawn inline as SVG so nothing is fetched from
 * the internet and they inherit the colour of the text around them.
 *
 * Icons are decorative here: every place that shows one also says the same
 * thing in words, so they are hidden from screen readers.
 */

/** Drawing instructions per icon, on a 24 x 24 grid, as stroked outlines. */
const SHAPES = {
  check: <path d="M4.5 12.5l5 5L19.5 7" />,
  cross: <path d="M6 6l12 12M18 6L6 18" />,
  warning: (
    <>
      <path d="M12 3.5L2.5 20h19L12 3.5z" />
      <path d="M12 10v4.5M12 17.2v.1" />
    </>
  ),
  stop: (
    <>
      <path d="M8 2.5h8L21.5 8v8L16 21.5H8L2.5 16V8L8 2.5z" />
      <path d="M8.5 8.5l7 7M15.5 8.5l-7 7" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9.5" />
      <path d="M12 11v6M12 7.2v.1" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9.5" />
      <path d="M12 7v5.5l3.5 2" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10.5" width="14" height="10" rx="2" />
      <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
    </>
  ),
};

/**
 * @param {object} props
 * @param {keyof typeof SHAPES} props.name
 * @param {number} [props.size] width and height in pixels
 */
export function Icon({ name, size = 20 }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {SHAPES[name]}
    </svg>
  );
}
