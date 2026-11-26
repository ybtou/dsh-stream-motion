/**
 * Mount one owned `<style>` element.
 *
 * The tag matters: the host's module loader claims untagged sheets for the
 * package that materializes next and later removes claimed tags, so a sheet
 * without `data-plugin` can be swept away by another package's reload. The tag
 * is the package's own name, which no other bundle answers to.
 */

const mounted = new Map()

/**
 * @param id - the element's id, which is also this sheet's identity.
 * @param text - the rules.
 * @param packageName - the bundle name the sheet is tagged with.
 * @returns the stop; it removes the element only while this call still owns it.
 */
export function mountStyle(id, text, packageName) {
  let sheet = document.getElementById(id)
  if (sheet === null) {
    sheet = document.createElement('style')
    sheet.id = id
    document.head.appendChild(sheet)
  }
  const token = {}
  mounted.set(id, token)
  sheet.dataset.plugin = packageName
  if (sheet.textContent !== text) sheet.textContent = text
  const element = sheet
  return () => {
    if (mounted.get(id) !== token) return
    mounted.delete(id)
    element.remove()
  }
}
