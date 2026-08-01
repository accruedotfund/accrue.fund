// Embedded Crossmint fiat checkout (card/bank → Base USDC).
// Client key is public (ck_*); order is created server-side with sk_*.

import { CrossmintProvider, CrossmintEmbeddedCheckout } from '@crossmint/client-sdk-react-ui'

const CLIENT_KEY = (import.meta.env.VITE_CROSSMINT_CLIENT_API_KEY as string) || ''

export function crossmintClientReady(): boolean {
  return Boolean(CLIENT_KEY && CLIENT_KEY.startsWith('ck_'))
}

export default function CrossmintCheckout({
  orderId,
  clientSecret,
  receiptEmail,
  onClose,
}: {
  orderId: string
  clientSecret: string
  receiptEmail: string
  onClose?: () => void
}) {
  if (!CLIENT_KEY) {
    return (
      <div className="notice" role="alert">
        Card/bank checkout is not configured.
        {onClose && (
          <button className="btn btn-quiet" style={{ marginTop: 8 }} onClick={onClose}>
            Back
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="crossmint-shell">
      {onClose && (
        <button
          type="button"
          className="btn btn-quiet"
          style={{ width: 'auto', marginBottom: 10, padding: '8px 14px' }}
          onClick={onClose}
        >
          ← Back
        </button>
      )}
      <CrossmintProvider apiKey={CLIENT_KEY}>
        <div className="crossmint-frame">
          <CrossmintEmbeddedCheckout
            orderId={orderId}
            clientSecret={clientSecret}
            payment={{
              receiptEmail,
              crypto: { enabled: false },
              fiat: { enabled: true },
              defaultMethod: 'fiat',
            }}
          />
        </div>
      </CrossmintProvider>
    </div>
  )
}
