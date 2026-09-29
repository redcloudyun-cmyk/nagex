import type {
  CreationExecutor,
  CreationKind,
  CreationRequest,
  CreationResult,
} from './creation-runtime.types.js';

export class CreationRuntime {
  private readonly executors = new Map<CreationKind, CreationExecutor>();

  constructor(executors: CreationExecutor[] = []) {
    for (const executor of executors) {
      this.registerExecutor(executor);
    }
  }

  public registerExecutor(executor: CreationExecutor): void {
    this.executors.set(executor.kind, executor);
  }

  public async create(request: CreationRequest): Promise<CreationResult> {
    const executor = this.executors.get(request.creationKind);
    if (!executor) {
      return {
        status: 'UNAVAILABLE',
        creationId: '',
        creationKind: request.creationKind,
        title: '',
        summary: '',
        content: '',
        openTarget: '',
        mimeType: 'text/plain',
        createdAt: new Date().toISOString(),
        errorCode: 'UNSUPPORTED_CREATION_KIND',
        errorMessage: `Creation capability '${request.creationKind}' is not supported by current runtime.`,
      };
    }

    return executor.execute(request);
  }

  public getSupportedKinds(): CreationKind[] {
    return Array.from(this.executors.keys());
  }
}
