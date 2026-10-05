import { WingsLogo3D } from './WingsLogo3D.js';

/**
 * The logo for the top of the side menu (light background): relief with a
 * subtle sway, 196×66 px as the brand hand-off sets. It goes inside the
 * `#wings-logo-slot` of AppShell; where 3D is not available the 2D principal
 * logo shows in the same place.
 */
export function SidebarLogo() {
  return <WingsLogo3D variant="light" motion="subtle" fit={0.94} width={196} height={66} />;
}
