/**
 * A numbered list of terminal commands, each introduced by a sentence that
 * says what it does and where to run it.
 *
 * Used wherever the app tells a person what to start (the chain, the file
 * service, the oracle). One command per step, with the explanation outside
 * the command, stays readable on a phone, where a long line with a trailing
 * comment would wrap into a jumble.
 */

/**
 * @param {object} props
 * @param {{ text: string, command: string }[]} props.steps in the order to run them
 */
export function CommandSteps({ steps }) {
  return (
    <ol className="steps">
      {steps.map((step) => (
        <li key={step.command}>
          {step.text}
          <code className="command-block">{step.command}</code>
        </li>
      ))}
    </ol>
  );
}
