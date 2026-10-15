export async function openMapLayers(page) {
  const button = page.getByRole('button', { name: 'Map layers and basemaps', exact: true });
  if (await button.getAttribute('aria-expanded') === 'false') await button.click();
}
