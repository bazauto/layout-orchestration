import { expect, test } from '@playwright/test';

test('app fits viewport with no persistent scrollbar', async ({ page }) => {
  await page.route('**://localhost:3000/api/layouts', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'layout-1', name: 'Test Layout' }]),
    });
  });

  await page.goto('/');

  // Resize to a few viewport sizes and confirm no document overflow.
  for (const vp of [
    { width: 1366, height: 768 },
    { width: 1024, height: 640 },
    { width: 800, height: 600 },
  ]) {
    await page.setViewportSize(vp);

    const overflow = await page.evaluate(() => {
      const doc = document.documentElement;
      const body = document.body;
      return {
        docH: doc.scrollHeight > doc.clientHeight,
        docW: doc.scrollWidth > doc.clientWidth,
        bodyH: body.scrollHeight > body.clientHeight,
        bodyW: body.scrollWidth > body.clientWidth,
      };
    });

    expect(overflow.docH, `doc overflows vertically at ${vp.width}x${vp.height}`).toBeFalsy();
    expect(overflow.docW, `doc overflows horizontally at ${vp.width}x${vp.height}`).toBeFalsy();
    expect(overflow.bodyH, `body overflows vertically at ${vp.width}x${vp.height}`).toBeFalsy();
    expect(overflow.bodyW, `body overflows horizontally at ${vp.width}x${vp.height}`).toBeFalsy();
  }
});
