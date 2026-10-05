/**
 * New-install MCP surface defaults, kept import-free so first-run and
 * readiness code can read them without loading the operation catalog.
 */
type Surface = 'verbs' | 'starter' | 'full';

/**
 * The surface fresh installs list to agents (`gbrain init` writes it to
 * `mcp.advertised_surface`). The held-out agent benchmark chooses between
 * 'verbs' and 'starter'; until it does, fresh installs list everything.
 */
export const NEW_INSTALL_ADVERTISED_SURFACE: Surface = 'full';

/**
 * The `serve --surface` every new stdio registration pins (REGISTRATION_SURFACE
 * in core/mcp-registration.ts). Once the benchmark picks an advertised surface,
 * registrations call everything (`full`) and init's advertised surface narrows
 * the list; until then they pin `starter`.
 */
export function newInstallServeSurface(): Surface {
  return NEW_INSTALL_ADVERTISED_SURFACE === 'full' ? 'starter' : 'full';
}

/** What a fresh `gbrain init` writes into `mcp`: the advertised surface, unless it is 'full'. */
export function newInstallAdvertisedSurface(): { advertised_surface?: 'verbs' | 'starter' } {
  return NEW_INSTALL_ADVERTISED_SURFACE === 'full' ? {} : { advertised_surface: NEW_INSTALL_ADVERTISED_SURFACE };
}
