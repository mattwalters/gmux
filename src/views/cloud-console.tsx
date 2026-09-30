// Placeholder: GMX-7 owns this copy. It replaces this component's body
// wholesale, so keep the props as they are.

export function CloudConsoleSteps(props: { redirectUri: string }) {
	return (
		<ol>
			<li>
				Open{" "}
				<a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer">
					the Google Cloud Console credentials page
				</a>{" "}
				in a new tab. Create a project, or pick one you already have.
			</li>
			<li>Set up the OAuth consent screen: choose External, leave it in Testing, and add yourself as a test user.</li>
			<li>
				Choose Create credentials, then OAuth client ID, then Web application. Under "Authorised redirect URIs", paste{" "}
				<code>{props.redirectUri}</code>.
			</li>
			<li>Google then shows a client ID and a client secret. Keep that tab open and copy them into the form below.</li>
		</ol>
	);
}
