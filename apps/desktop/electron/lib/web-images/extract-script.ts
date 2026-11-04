/**
 * Scripts that run INSIDE the page of the hidden browser. Plain strings: the page has
 * no access to anything of ours, and what they return is only data (see RawImage).
 */

/** Generic page: every <img> (largest srcset entry), og:image, with the link that wraps it. */
export const EXTRACT_PAGE_IMAGES = `
(() => {
  const pick = (img) => {
    const set = img.getAttribute('srcset') || img.getAttribute('data-srcset') || ''
    let best = ''
    let bestW = 0
    for (const part of set.split(',')) {
      const [u, d] = part.trim().split(/\\s+/)
      const w = parseFloat(d) || 0
      if (u && w >= bestW) { best = u; bestW = w }
    }
    return best || img.getAttribute('data-src') || img.currentSrc || img.src
  }
  const out = []
  const meta = document.querySelector('meta[property="og:image"], meta[name="twitter:image"]')
  if (meta && meta.content) out.push({ src: meta.content, alt: document.title, href: location.href })
  for (const img of document.images) {
    const r = img.getBoundingClientRect()
    const a = img.closest('a[href]')
    out.push({
      src: pick(img),
      href: a ? a.href : undefined,
      alt: img.alt || img.title || (a && (a.getAttribute('aria-label') || a.title)) || '',
      width: Math.round(r.width) || img.naturalWidth || undefined,
      height: Math.round(r.height) || img.naturalHeight || undefined,
    })
  }
  return out
})()
`

/**
 * Bing's image results carry the real file (murl), the page (purl) and the title (t)
 * in the JSON of each result's link — that is the full-size address, not the thumbnail.
 */
export const EXTRACT_BING_IMAGES = `
(() => {
  const out = []
  for (const a of document.querySelectorAll('a.iusc[m]')) {
    try {
      const m = JSON.parse(a.getAttribute('m'))
      if (m && m.murl) out.push({ src: m.murl, thumb: m.turl, href: m.purl, alt: m.t || '' })
    } catch {}
  }
  return out
})()
`

/** Scrolls to the end in steps, so lazy-loaded images get their address. */
export const SCROLL_PAGE = `
(async () => {
  for (let i = 0; i < 6; i++) {
    window.scrollBy(0, window.innerHeight * 0.9)
    await new Promise((r) => setTimeout(r, 350))
  }
  window.scrollTo(0, 0)
})()
`
