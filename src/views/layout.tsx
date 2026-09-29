import { raw } from "hono/html";
import type { Child } from "hono/jsx";

export function Layout(props: { title: string; children: Child }) {
	return (
		<>
			{raw("<!doctype html>")}
			<html lang="en">
				<head>
					<meta charset="utf-8" />
					<meta name="viewport" content="width=device-width, initial-scale=1" />
					<meta name="robots" content="noindex" />
					<title>{`${props.title} · gmux`}</title>
					<link rel="stylesheet" href="/style.css" />
				</head>
				<body>
					<header class="site">
						<a class="brand" href="/">
							gmux
						</a>
					</header>
					<main>{props.children}</main>
				</body>
			</html>
		</>
	);
}
