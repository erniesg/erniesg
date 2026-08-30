import { describe, expect, it } from 'vitest'
import { fixtureFile } from '../../tests/fixtures/pdf-fixtures'
import { reconstructPdf } from './pdf'

describe('Study holdout safe rejection', () => {
  it('rejects active PDF content before reconstruction', async () => {
    await expect(
      reconstructPdf(
        await fixtureFile('heldout-v1/holdout-hostile-javascript.pdf'),
      ),
    ).rejects.toMatchObject({
      name: 'PdfImportError',
      code: 'UNSUPPORTED_PDF',
      message: expect.stringMatching(/not supported.*Nothing was saved/iu),
    })
  })
})
