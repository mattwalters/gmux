import { raw } from "hono/html";
import type { Child } from "hono/jsx";

/** Who owns this instance: an address, null before anyone has claimed it, undefined when it couldn't be read. */
export type OwnerView = { email: string } | null | undefined;

function OwnerBanner(props: { owner: OwnerView }) {
	if (props.owner === undefined) return <span class="owner">Owner unavailable</span>;
	if (props.owner === null) return <span class="owner">Not yet claimed</span>;
	return (
		<span class="owner">
			Owned by <strong>{props.owner.email}</strong>
		</span>
	);
}

/** `signOutCsrf` is set only when the viewer has a session, which adds the sign-out button. */
export function Layout(props: { title: string; owner: OwnerView; signOutCsrf?: string; children: Child }) {
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
						<OwnerBanner owner={props.owner} />
						{props.signOutCsrf && (
							<form method="post" action="/signout">
								<input type="hidden" name="csrf" value={props.signOutCsrf} />
								<button type="submit" class="link">
									Sign out
								</button>
							</form>
						)}
					</header>
					<main>{props.children}</main>
				</body>
			</html>
		</>
	);
}
