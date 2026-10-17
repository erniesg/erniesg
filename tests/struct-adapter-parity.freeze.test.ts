import { it } from 'vitest'
import { freezeAdapterFixtures } from './fixtures/struct-adapter-parity/freeze'

it.skipIf(!process.env.STRUCT_PARITY_FREEZE)(
  'freezes the struct adapter parity fixtures',
  async () => {
    await freezeAdapterFixtures()
  },
)
