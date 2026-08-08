import {
  validatePublicationSourceResult,
  type PublicationSourceAdapter,
  type PublicationSourceResult,
} from './source-adapter'
import { astroPublicationAdapter } from './adapters/astro'
import { payloadLexicalSourceAdapter } from './adapters/payload-lexical'

export type PublicationBundle = PublicationSourceResult

export interface PublicationRenderer {
  readonly id: string
  render(
    bundle: PublicationBundle,
    request: { outputDirectory: string; profiles: readonly string[] },
  ): Promise<unknown>
}

export class PublicationAdapterRegistry {
  readonly #adapters = new Map<string, PublicationSourceAdapter<unknown>>()

  register<Input>(adapter: PublicationSourceAdapter<Input>) {
    if (this.#adapters.has(adapter.id))
      throw new Error(`Publication adapter already registered: ${adapter.id}`)
    this.#adapters.set(adapter.id, adapter as PublicationSourceAdapter<unknown>)
    return this
  }

  async resolve(
    adapterId: string,
    locator: unknown,
  ): Promise<PublicationBundle> {
    const adapter = this.#adapters.get(adapterId)
    if (!adapter)
      throw new Error(`Unknown publication source adapter: ${adapterId}`)
    return validatePublicationSourceResult(await adapter.adapt(locator))
  }
}

export async function buildRegisteredPublication(
  registry: PublicationAdapterRegistry,
  renderer: PublicationRenderer,
  request: {
    adapterId: string
    locator: unknown
    outputDirectory: string
    profiles: readonly string[]
  },
) {
  const bundle = await registry.resolve(request.adapterId, request.locator)
  return renderer.render(bundle, request)
}

export function createDefaultPublicationAdapterRegistry() {
  return new PublicationAdapterRegistry()
    .register(astroPublicationAdapter)
    .register(payloadLexicalSourceAdapter)
}
