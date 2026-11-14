export function RequestLine({ fallback = false }: { fallback?: boolean }) {
  const caption = fallback ? 'routing-line-caption' : 'request-line-caption';
  return (
    <figure
      className="request-line"
      aria-labelledby={caption}
      data-journey={fallback ? 'fallback' : 'direct'}
    >
      <figcaption id={caption}>
        {fallback ? 'When a provider fails' : 'A request, from end to end'}
      </figcaption>
      <div className={`request-map${fallback ? '' : ' hero-request-map'}`}>
        <svg className="request-wires" aria-hidden="true">
          <path data-wire="0" />
          <path data-wire="1" />
          {fallback && (
            <>
              <path data-wire="2" />
              <path data-wire="3" />
            </>
          )}
          <circle className="request-dot" r="4" />
        </svg>
        <div className="request-origin">
          <span className="map-station" data-station="origin" aria-hidden="true">
            <i className="station-light" />
          </span>
          <strong>Your application</strong>
          <code>POST /v1/decisions</code>
        </div>
        <div className="request-interchange">
          <span className="map-interchange" data-station="route" aria-hidden="true">
            <i className="station-light" />
          </span>
          <div>
            <strong>{fallback ? 'One route' : 'The model you choose'}</strong>
            {fallback && <span>Providers in order</span>}
          </div>
          {fallback && (
            <ol className="provider-order" aria-label="Providers are tried in order">
              <li>
                <span className="provider-station" data-station="first" aria-hidden="true">
                  <i className="station-light" />
                </span>
                <span>Try first</span>
                <span className="failure-signal" aria-hidden="true">
                  <svg viewBox="0 0 12 12">
                    <path d="m3 3 6 6m0-6-6 6" />
                  </svg>
                  Failed
                </span>
              </li>
              <li>
                <span className="provider-station" data-station="next" aria-hidden="true">
                  <i className="station-light" />
                </span>
                <span>If needed</span>
              </li>
            </ol>
          )}
        </div>
        <div className="request-answer">
          <span className="map-station" data-station="answer" aria-hidden="true">
            <i className="station-light" />
          </span>
          <strong>An answer</strong>
          <span className="answer-details">Usage, cost &amp; attempts</span>
        </div>
      </div>
      <p className="map-note">
        {fallback
          ? 'A request follows the route, trying providers in order.'
          : 'One API call returns the answer with its usage, cost and attempts.'}
      </p>
      <p className="sr-only">
        {fallback
          ? 'Illustration: if the first provider fails, the request continues to the next provider, then returns an answer with usage, cost and attempts.'
          : 'A request travels from your application to the model you choose, then returns an answer.'}
      </p>
    </figure>
  );
}
