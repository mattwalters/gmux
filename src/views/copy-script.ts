// The one script gmux serves, at GET /copy.js: wires each
// `button[data-copy="<id>"]` to copy that element's text. A string constant, so
// there's no bundler and no static-assets pipeline. Pages load it with
// `<script src="/copy.js">`; CSP allows `script-src 'self'` and no inline script.

export const COPY_SCRIPT = `for (const button of document.querySelectorAll("button[data-copy]")) {
	button.addEventListener("click", async () => {
		const source = document.getElementById(button.dataset.copy);
		if (!source) return;
		try {
			await navigator.clipboard.writeText(source.textContent);
			button.textContent = "Copied";
		} catch {
			button.textContent = "Select the text and copy it";
		}
	});
}
`;
