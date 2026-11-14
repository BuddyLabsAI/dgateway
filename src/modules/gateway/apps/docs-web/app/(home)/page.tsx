import Link from 'next/link';
import { ArrowRight, CornerDownRight } from 'lucide-react';
import { LandingMotion } from '@/components/landing-motion';
import { HeroFlow } from '@/components/hero-flow';
import { RequestLine } from '@/components/request-line';

export default function HomePage() {
  return (
    <LandingMotion>
      <section className="landing-hero" aria-labelledby="hero-title">
        <div className="hero-copy">
          <h1 id="hero-title">
            <span className="hero-line" data-hero-line>
              Unified self-hosted API gateway
            </span>
            <br />
            <span className="hero-line" data-hero-line>
              for decision models.
            </span>
          </h1>
          <div className="hero-aside">
            <p className="landing-lead">
              Your app calls a single API, and you choose any model behind it. Switch models without
              changing your code.
            </p>
            <div className="landing-actions">
              <Link className="primary-link" href="/docs/guides/getting-started">
                Run your gateway <ArrowRight aria-hidden="true" size={18} />
              </Link>
              <Link className="text-link" href="/docs/reference/decisions">
                Explore the API <ArrowRight aria-hidden="true" size={16} />
              </Link>
            </div>
            <p className="hero-details">
              Single-owner <span aria-hidden="true">/</span> OpenAI-shaped{' '}
              <span aria-hidden="true">/</span> Built with Bun
            </p>
          </div>
        </div>
        <HeroFlow />
      </section>

      <section className="explainer-section" aria-labelledby="explainer-title">
        <div className="explainer-copy">
          <h2 id="explainer-title">What is a decision model?</h2>
          <p>
            A decision model, such as Jev, gives your code an answer it can use directly: a
            category, a yes or no, or a score. OpenAI offers decision models through its Decisions
            API.
          </p>
        </div>
        <div className="explainer-choices">
          <p>In the console, you choose the model behind the API:</p>
          <ul>
            <li>OpenAI</li>
            <li>OpenRouter</li>
            <li>TypeSafe</li>
            <li>Another hosted vendor</li>
            <li>A model on your own machine</li>
          </ul>
        </div>
      </section>

      <section className="local-section" aria-labelledby="local-title">
        <div>
          <h2 id="local-title">
            Try it on your machine.
            <br />
            No API key needed.
          </h2>
          <p>
            A new install has a test route named <code>default</code>. It answers with a built-in
            mock instead of a real model, so you need no API key. Connect real providers when you
            are ready.
          </p>
          <Link className="text-link" href="/docs/guides/getting-started">
            Start with the mock <ArrowRight aria-hidden="true" size={16} />
          </Link>
        </div>
        <div className="local-terminal">
          <div className="terminal-heading">
            <span className="station" aria-hidden="true" />
            Start with the image
          </div>
          <pre aria-label="Start dgateway with Docker">
            <code>{`docker run -d --name dgateway \\
  -p 127.0.0.1:8790:8790 \\
  -v dgateway-data:/data \\
  --add-host host.docker.internal:host-gateway \\
  -e ADMIN_TOKEN=replace-with-a-long-random-token \\
  -e GATEWAY_SECRET=replace-with-a-separate-stable-secret \\
  ghcr.io/buddylabsai/dgateway:latest`}</code>
          </pre>
          <p>
            Before you use it beyond a local trial, replace the <code>ADMIN_TOKEN</code> and{' '}
            <code>GATEWAY_SECRET</code> values with two different long random strings. Keep{' '}
            <code>GATEWAY_SECRET</code> the same over time: it encrypts the provider keys you store.{' '}
            <Link href="/docs/guides/getting-started">
              Follow the setup guide <ArrowRight aria-hidden="true" size={14} />
            </Link>
          </p>
        </div>
      </section>

      <section className="routing-section" aria-labelledby="routing-title">
        <div className="routing-copy">
          <h2 id="routing-title">How routing works</h2>
          <p>
            Your app sends a route name in the <code>model</code> field. A route is a list of steps
            in order. Each step names a provider and a model. dgateway tries the first step. If that
            call fails, it tries the next one.
          </p>
          <p>
            dgateway moves to the next step after a missing key, a timeout, a network error, a
            malformed answer, an upstream HTTP error or a request over the provider's limits. An
            upstream HTTP <code>400</code> or <code>422</code> stops the route instead.
          </p>
          <Link className="text-link" href="/docs/guides/routing">
            Read the routing guide <ArrowRight aria-hidden="true" size={16} />
          </Link>
        </div>
        <RequestLine fallback />
      </section>

      <section className="explore-section" aria-labelledby="explore-title">
        <div className="explore-intro">
          <h2 id="explore-title">
            One endpoint.
            <br />
            Three kinds of answer.
          </h2>
          <p>
            Ask for a category, a yes or no, or a score. One response holds the answers, the token
            usage and the cost. <code>confidence</code> is not proof that an answer is right. Test
            your provider, model, instructions and thresholds on examples you have labelled yourself
            before you rely on them.
          </p>
          <Link className="text-link" href="/docs">
            Read the introduction <ArrowRight aria-hidden="true" size={16} />
          </Link>
        </div>
        <nav aria-label="Explore the documentation" className="explore-links">
          <Link href="/docs/guides/routing">
            <div>
              <h3>Build your fallback route</h3>
              <p>Choose providers and the order to try them.</p>
            </div>
            <ArrowRight aria-hidden="true" size={20} />
          </Link>
          <Link href="/docs/reference/decisions">
            <div>
              <h3>Write decision questions</h3>
              <p>Every field for choice, yes/no and score questions, with tested examples.</p>
            </div>
            <ArrowRight aria-hidden="true" size={20} />
          </Link>
          <Link href="/docs/guides/cost">
            <div>
              <h3>Understand the cost</h3>
              <p>
                See what each decision cost and where the number came from. dgateway does not stop
                spending at a budget.
              </p>
            </div>
            <ArrowRight aria-hidden="true" size={20} />
          </Link>
          <Link href="/docs/guides/providers">
            <div>
              <h3>Connect local and hosted models</h3>
              <p>Keep a route local-only or choose a hosted fallback.</p>
            </div>
            <ArrowRight aria-hidden="true" size={20} />
          </Link>
        </nav>
        <p>
          dgateway has no chat-completions endpoint, so chat apps and code editors cannot use it as
          a model server. It can still call chat models to answer decision questions. It does not
          choose the best model for a task. You choose the providers and their order, and you test
          them.
        </p>
      </section>
      <footer className="landing-footer">
        <span className="wordmark">
          <span className="station" aria-hidden="true" />
          dgateway
        </span>
        <span>Free under the MIT license. Your model providers may still charge for calls.</span>
        <Link href="/docs/guides/security">
          Operate securely <CornerDownRight aria-hidden="true" size={16} />
        </Link>
      </footer>
    </LandingMotion>
  );
}
