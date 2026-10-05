import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';

export interface PageTab {
  label: string;
  /** A route: the tab is a link and the router says which is active. */
  to?: string;
  /** A state: the page says which is active and reacts to the click. */
  active?: boolean;
  onClick?: () => void;
  count?: number;
}

/**
 * The standard head of a screen (model A): the title, one short line under
 * it, segmented tabs when the screen has views, and the actions on the
 * right. Filters go underneath in one line (`.filters-row`), never in here.
 */
export function PageHeader({
  title,
  subtitle,
  tabs,
  actions,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  tabs?: PageTab[];
  actions?: ReactNode;
  /** Anything else that sits under the title line: a filters row, a notice. */
  children?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div className="page-head-row">
        <div className="page-head-title">
          <h1>{title}</h1>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {tabs && tabs.length > 0 && (
          <div className="page-tabs" role="tablist">
            {tabs.map((tab) =>
              tab.to ? (
                <NavLink
                  key={tab.label}
                  to={tab.to}
                  end
                  role="tab"
                  className={({ isActive }) => (isActive ? 'is-active' : '')}
                >
                  {tab.label}
                  {tab.count !== undefined && <span>{tab.count}</span>}
                </NavLink>
              ) : (
                <button
                  key={tab.label}
                  type="button"
                  role="tab"
                  aria-selected={tab.active}
                  className={tab.active ? 'is-active' : ''}
                  onClick={tab.onClick}
                >
                  {tab.label}
                  {tab.count !== undefined && <span>{tab.count}</span>}
                </button>
              ),
            )}
          </div>
        )}
        {actions && <div className="page-head-actions">{actions}</div>}
      </div>
      {children}
    </header>
  );
}
