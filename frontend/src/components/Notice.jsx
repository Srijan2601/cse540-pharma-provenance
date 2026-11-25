/**
 * A boxed message: information, success, a warning or an error.
 *
 * The tone is carried by an icon and by the wording, with colour as a third
 * cue. Messages that appear in response to an action are announced to screen
 * readers through the `live` prop.
 */

import { Icon } from "./Icon.jsx";

const ICONS = { info: "info", success: "check", warning: "warning", error: "stop" };

/**
 * @param {object} props
 * @param {"info"|"success"|"warning"|"error"} [props.tone]
 * @param {string} [props.title]   bold first line
 * @param {boolean} [props.live]   announce the message when it appears (errors interrupt, others wait their turn)
 * @param {import("react").ReactNode} props.children
 */
export function Notice({ tone = "info", title, live = false, children }) {
  const role = live ? (tone === "error" ? "alert" : "status") : undefined;
  return (
    <div className={`notice notice--${tone}`} role={role}>
      <span className="notice__icon">
        <Icon name={ICONS[tone]} size={22} />
      </span>
      <div className="notice__body">
        {title ? <p className="notice__title">{title}</p> : null}
        {children}
      </div>
    </div>
  );
}
