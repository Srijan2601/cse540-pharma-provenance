/**
 * A lot's QR code and the link it encodes.
 *
 * The code is generated in the browser by the "qrcode" package and shown as
 * an image with a data: URL, so no QR service is contacted. The link is
 * printed next to it: a person can check where the code leads before scanning
 * it, and can still use it where no camera is at hand.
 */

import QRCode from "qrcode";
import { useEffect, useState } from "react";

import { config } from "../config.js";
import { buildVerifyUrl } from "../lib/verifyLink.js";

/**
 * @param {object} props
 * @param {import("../lib/networks.js").Network} props.network
 * @param {number} props.lotId
 */
export function LotQrCode({ network, lotId }) {
  const url = buildVerifyUrl({ baseUrl: config.verifyBaseUrl, lotId, chainId: network.chainId, registry: network.registry });
  const [image, setImage] = useState(null);

  useEffect(() => {
    let cancelled = false;
    // Error correction "M" survives a slightly smudged print; the 4-module margin is the quiet zone scanners need.
    QRCode.toDataURL(url, { errorCorrectionLevel: "M", margin: 4, width: 400 })
      .then((dataUrl) => {
        if (!cancelled) setImage(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setImage(null);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  return (
    <figure className="qr">
      {image ? (
        <img className="qr__image" src={image} alt={`QR code that opens the verify page of lot ${lotId}`} />
      ) : (
        <div className="qr__image" role="img" aria-label="QR code is being drawn" />
      )}
      <figcaption className="qr__caption">
        <p className="small muted">Scan the code, or open this link, to verify lot {lotId}:</p>
        <p className="small breakable">
          <a href={url}>{url}</a>
        </p>
      </figcaption>
    </figure>
  );
}
