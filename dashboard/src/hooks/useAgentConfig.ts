import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useCurrentProject } from '../context/CurrentProjectContext';
import type { ConnectorIconKey } from '../components/brain/connectorCatalog';

interface Priority {
  id: string;
  label: string;
  enabled: boolean;
}

type ToolStatus = 'online' | 'warning' | 'error';
type EdgeDirection = 'undirected' | 'inbound' | 'outbound' | 'bidirectional';

interface Tool {
  id: string;
  name: string;
  description: string;
  status: ToolStatus;
  active: boolean;
  // Removed from the graph by the user (trash icon). Restored from the "+ Add tool" menu's
  // Hidden-tools section. Distinct from `active` (online/offline wiring). Persisted in the
  // agent_config.tools JSONB like every other field — no migration needed.
  hidden?: boolean;
  direction?: EdgeDirection;
  accent?: string;
  icon?: ConnectorIconKey;
}

const DEFAULT_PRIORITIES: Priority[] = [
  { id: 'p1', label: 'Maintain the fleet',    enabled: true  },
  { id: 'p2', label: 'Security audit',         enabled: true  },
  { id: 'p3', label: 'Pentest',                enabled: false },
  { id: 'p4', label: 'Develop feature: ',      enabled: false },
];

// Service-backed (its node turns green/red from the nff-diagnosis heartbeat in
// AgentManagementTab's SERVICE_BY_TOOL — keep the `name` in sync with that key).
// This subsumes the old "Analytics Tool" placeholder (cross-device crash
// correlation) — same tool, now actually built as nff-diagnosis.
const DIAGNOSIS_TOOL: Tool = { id: 't6', name: 'Diagnosis Tool', description: 'ESP32 crash diagnosis + fleet crash analytics: parse panic dumps, resolve symbols, root-cause analysis, cross-device crash correlation', status: 'online', active: true };

// nff-builder. Service-backed via SERVICE_BY_TOOL['Builder Tool'] = 'nff-builder'
// in AgentManagementTab: its node reads green/red from the builder heartbeat
// (offline until that service beats). Ensured present on older configs below.
const BUILDER_TOOL: Tool = { id: 't8', name: 'Builder Tool', description: 'Agentic feature builder: interview-driven feature planning, plan + branch creation via nff-github, and canary rollout', status: 'online', active: true };

const DEFAULT_TOOLS: Tool[] = [
  { id: 't1', name: 'Fleet Tool',       description: 'Real-time device presence, command delivery, crash + diagnostics retrieval over MQTT', status: 'online', active: true },
  { id: 't2', name: 'OTA Tool',         description: 'Firmware flashing, staged rollouts, Wokwi simulation, version management',    status: 'online', active: true },
  { id: 't5', name: 'GitHub Connector', description: 'Receives push webhooks to trigger agent; proposes code patches via PR',       status: 'online', active: true, direction: 'bidirectional', accent: '#1f6feb', icon: 'github' },
  DIAGNOSIS_TOOL,
  BUILDER_TOOL,
];

// agent_config is one row per project (the singleton id=1 was retired in migration
// 02). ensureRow seeds the current project's row with the defaults on first use.
async function ensureRow(projectId: string) {
  const { data } = await supabase.from('agent_config').select('project_id').eq('project_id', projectId).maybeSingle();
  if (!data) {
    await supabase.from('agent_config').insert({
      project_id: projectId,
      priorities: DEFAULT_PRIORITIES,
      tools: DEFAULT_TOOLS,
    });
  }
}

export function useAgentConfig() {
  const { currentProjectId } = useCurrentProject();
  const [priorities, setPrioritiesState] = useState<Priority[]>(DEFAULT_PRIORITIES);
  const [tools, setToolsState]           = useState<Tool[]>(DEFAULT_TOOLS);
  const [loading, setLoading]            = useState(true);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestRef = useRef({ priorities: DEFAULT_PRIORITIES, tools: DEFAULT_TOOLS });

  useEffect(() => {
    if (!currentProjectId) return;
    ensureRow(currentProjectId).then(() => {
      supabase
        .from('agent_config')
        .select('priorities, tools')
        .eq('project_id', currentProjectId)
        .single()
        .then(({ data }) => {
          if (data) {
            const p = (data.priorities as Priority[] | null) ?? DEFAULT_PRIORITIES;
            const saved = (data.tools as Tool[] | null) ?? DEFAULT_TOOLS;
            // Drop retired nodes: the "Analytics Tool" placeholder (merged into the
            // Diagnosis Tool), the "Web Search Tool" (removed), and the "Pentester Tool"
            // (nff-pentester retired from the default graph). Then append any built-in
            // tools that postdate this saved config (Diagnosis, Builder) so new tools
            // always surface. Persisted on the next edit via scheduleSave — not
            // force-written here.
            const cleaned = saved.filter(
              x => x.name !== 'Analytics Tool' && x.name !== 'Web Search Tool' && x.name !== 'Pentester Tool',
            );
            const ensure = (list: Tool[], tool: Tool) =>
              list.some(x => x.name === tool.name) ? list : [...list, tool];
            const t = ensure(ensure(cleaned, DIAGNOSIS_TOOL), BUILDER_TOOL);
            setPrioritiesState(p);
            setToolsState(t);
            latestRef.current = { priorities: p, tools: t };
          }
          setLoading(false);
        });
    });

    // Pick up priorities appended server-side — e.g. nff-builder advertises a feature when
    // it ships a canary OTA (announce_feature_priority). Append-only merge: add any incoming
    // priority whose id isn't already local, never overwriting local edits (so this is a
    // no-op echo of the user's own debounce-save, and doesn't clobber in-flight reorders).
    const channel = supabase
      .channel(`agent-config-${currentProjectId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'agent_config', filter: `project_id=eq.${currentProjectId}` },
        payload => {
          const incoming = ((payload.new as Record<string, unknown>)?.priorities as Priority[] | null) ?? [];
          setPrioritiesState(prev => {
            const have = new Set(prev.map(p => p.id));
            const added = incoming.filter(p => p && !have.has(p.id));
            if (added.length === 0) return prev;
            const next = [...prev, ...added];
            latestRef.current = { ...latestRef.current, priorities: next };
            return next;
          });
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [currentProjectId]);

  function scheduleSave(p: Priority[], t: Tool[]) {
    latestRef.current = { priorities: p, tools: t };
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      if (!currentProjectId) return;
      supabase
        .from('agent_config')
        .update({ priorities: latestRef.current.priorities, tools: latestRef.current.tools, updated_at: new Date().toISOString() })
        .eq('project_id', currentProjectId);
    }, 500);
  }

  function setPriorities(p: Priority[] | ((prev: Priority[]) => Priority[])) {
    setPrioritiesState(prev => {
      const next = typeof p === 'function' ? p(prev) : p;
      scheduleSave(next, latestRef.current.tools);
      return next;
    });
  }

  function setTools(t: Tool[] | ((prev: Tool[]) => Tool[])) {
    setToolsState(prev => {
      const next = typeof t === 'function' ? t(prev) : t;
      scheduleSave(latestRef.current.priorities, next);
      return next;
    });
  }

  return { priorities, tools, loading, setPriorities, setTools };
}
