import {
  validatePublicationSourceResult,
  type PublicationSourceAdapter,
  type PublicationSourceResult,
} from './source-adapter'
import { payloadLexicalSourceAdapter } from './adapters/payload-lexical'
import { astroPublicationAdapter } from './adapters/astro'

/** The value handed from a source adapter to a renderer. */
export type PublicationBundle = PublicationSourceResult

export interface PublicationRenderer {
  readonly id: string
  render(
    bundle: PublicationBundle,
    request: { outputDirectory: string; profiles: readonly string[] },
  ): Promise<unknown> | unknown
}

/**
 * Small, source-neutral registry.  Adapters are the only place that knows
 * about an input format; renderers receive a validated bundle and never see
 * the source locator or source-specific types.
 */
export class PublicationAdapterRegistry {
  readonly #adapters = new Map<string, PublicationSourceAdapter<unknown>>()

  register<Input>(adapter: PublicationSourceAdapter<Input>) {
    if (!adapter || typeof adapter.id !== 'string' || !adapter.id) {
      throw new TypeError('Publication adapters require a non-empty id')
    }
    if (this.#adapters.has(adapter.id))
      throw new Error(`Publication adapter already registered: ${adapter.id}`)
    if (typeof adapter.adapt !== 'function')
      throw new TypeError(`Publication adapter ${adapter.id} has no adapt method`)
    this.#adapters.set(adapter.id, adapter as PublicationSourceAdapter<unknown>)
    return this
  }

  has(adapterId: string) {
    return this.#adapters.has(adapterId)
  }

  get(adapterId: string) {
    return this.#adapters.get(adapterId)
  }

  ids() {
    return [...this.#adapters.keys()]
  }

  async resolve(adapterId: string, locator: unknown): Promise<PublicationBundle> {
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
  if (!renderer || typeof renderer.render !== 'function')
    throw new TypeError('Publication renderers require a render method')
  const bundle = await registry.resolve(request.adapterId, request.locator)
  return renderer.render(bundle, request)
}

/**
 * The default registry is intentionally assembled without a Payload package
 * or a network client.  Callers may register the adapters they need; this
 * helper is kept here so CLI and tests share one boundary.
 */
export function createPublicationAdapterRegistry(
  adapters: readonly PublicationSourceAdapter<unknown>[] = [],
) {
  return adapters.reduce(
    (registry, adapter) => registry.register(adapter),
    new PublicationAdapterRegistry(),
  )
}

export const publicationAdapterRegistry = new PublicationAdapterRegistry()

// Payload is safe to register by default because it consumes only decoded
// local JSON.  Astro (and future sources) can be added by the application
// without changing this source-neutral registry.
publicationAdapterRegistry
  .register(payloadLexicalSourceAdapter)
  .register(astroPublicationAdapter)

export function createDefaultPublicationAdapterRegistry() {
  return new PublicationAdapterRegistry()
    .register(payloadLexicalSourceAdapter)
    .register(astroPublicationAdapter)
}
