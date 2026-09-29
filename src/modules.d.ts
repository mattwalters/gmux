// wrangler.jsonc's `rules` bundles *.css as a Text module: importing one
// gives its contents as a string. No build step.
declare module "*.css" {
	const text: string;
	export default text;
}
