/** Renders a URL in a real browser and returns the DOM after JavaScript has run. */
export interface PageRenderer {
  render(url: string): Promise<{ url: string; html: string }>;
}
