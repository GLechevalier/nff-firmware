import { useCurrentProject } from '../../context/CurrentProjectContext';

/**
 * Project picker shown in the sidebar header. Switching writes the choice to
 * localStorage and updates the context; App is keyed on currentProjectId so the
 * whole dashboard remounts and every hook refetches scoped to the new project.
 * A single-project (Free plan) user still sees their project name here.
 */
export function ProjectSwitcher() {
  const { projects, currentProjectId, setCurrentProjectId } = useCurrentProject();

  if (projects.length <= 1) {
    const only = projects[0];
    return (
      <div
        title={only ? `${only.name} (${only.plan})` : undefined}
        style={{
          fontSize: 11, color: '#666', marginTop: 4,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          display: 'flex', alignItems: 'center', gap: 4,
        }}
      >
        ▸ {only?.name ?? '—'}
        {only?.is_demo && (
          <span style={{
            fontSize: 9, border: '1px solid #f59e0b', color: '#f59e0b',
            padding: '0 3px', letterSpacing: 0.5, flexShrink: 0,
          }}>
            DEMO
          </span>
        )}
      </div>
    );
  }

  return (
    <select
      value={currentProjectId}
      onChange={e => setCurrentProjectId(e.target.value)}
      style={{
        marginTop: 4,
        width: '100%',
        fontSize: 11,
        border: '1px solid #000',
        background: '#fff',
        color: '#000',
        padding: '2px 4px',
        cursor: 'pointer',
      }}
      aria-label="Switch project"
    >
      {projects.map(p => (
        <option key={p.id} value={p.id}>
          {p.name}{p.is_demo ? ' [DEMO]' : ''}{p.plan === 'team' ? ' (team)' : ''}
        </option>
      ))}
    </select>
  );
}
