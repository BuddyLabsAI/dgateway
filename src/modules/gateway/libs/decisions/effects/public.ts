import { GatewayError, type DecisionRequest } from '../schemas/types';
import { decide, type DecideDeps } from './decide';
import { clientAuth, publicModels, rejectionLog } from '../functions/public';

export class PublicDecisions {
  constructor(
    private deps: DecideDeps,
    private authenticate: (key: string) => boolean,
  ) {}

  authorize(token: string | undefined) {
    const settings = this.deps.settings();
    const action = clientAuth(settings, token, undefined);
    const result =
      action === 'check' ? clientAuth(settings, token, this.authenticate(token!)) : action;
    if (result === 'deny')
      throw new GatewayError(401, 'authentication_error', 'Invalid or missing client key');
  }

  models() {
    return publicModels(this.deps.routes());
  }

  execute(request: DecisionRequest) {
    return decide(request, this.deps);
  }

  now() {
    return this.deps.clock();
  }

  logRejection(start: number, error: GatewayError, body: unknown = null) {
    const d = this.deps;
    d.log(rejectionLog(start, error, body, d.settings(), d.id('log'), d.clock(), d.clock()));
  }
}
