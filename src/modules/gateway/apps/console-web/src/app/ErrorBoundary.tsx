import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  failed: boolean;
}

/** Keeps one crashing screen from blanking the whole console. */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Screen failed to render", error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return (
        <div className="state state--error" role="alert">
          <p className="state-title">This screen hit an unexpected error</p>
          <p className="state-body">Reload the page. If it happens again, the browser console has the details.</p>
        </div>
      );
    }
    return this.props.children;
  }
}
