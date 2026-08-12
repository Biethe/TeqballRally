/**
 * Make a page look like a player who has been here before.
 *
 * The first launch of the game goes straight into the coached lesson and
 * offers no title screen, which is the point of it — but every harness in this
 * directory drives the game from that title screen, and a fresh browser
 * context is, correctly, a first launch. Seeding the preference is what a
 * returning player *is*, so this is not a special test mode: it is the second
 * launch.
 *
 * Runs before any of the page's own scripts, so the game reads it at boot.
 */
export async function asReturningPlayer(page) {
  await page.addInitScript(() => {
    try {
      const raw = localStorage.getItem("teqopen.prefs");
      const prefs = raw ? JSON.parse(raw) : {};
      localStorage.setItem("teqopen.prefs", JSON.stringify({ ...prefs, coached: true }));
    } catch {
      // Private mode: the harness will simply see the lesson, and say so.
    }
  });
}
