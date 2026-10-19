import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useCurrentProject } from '../context/CurrentProjectContext';

type StepStatus = 'done' | 'running' | 'pending';

interface TaskStep {
  id: string;
  label: string;
  status: StepStatus;
}

interface AgentTask {
  title: string;
  steps: TaskStep[];
}

export function useAgentTasks() {
  const { currentProjectId } = useCurrentProject();
  const [task, setTask] = useState<AgentTask | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!currentProjectId) return;
    let cancelled = false;

    // The active task is the most recent incomplete one for this project; its steps
    // are the live breadcrumb spine. The worker swaps tasks and replaces steps as the
    // agent moves between tools, so rather than patch state per row we just re-run
    // this query on any change — correct under task-switching and step inserts/deletes.
    const load = () => {
      supabase
        .from('agent_tasks')
        .select('*, agent_task_steps(*)')
        .eq('project_id', currentProjectId)
        .is('completed_at', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
        .then(({ data }) => {
          if (cancelled) return;
          if (data) {
            const steps = [...(data.agent_task_steps as Record<string, unknown>[])]
              .sort((a, b) => (a.position as number) - (b.position as number))
              .map(s => ({
                id: s.id as string,
                label: s.label as string,
                status: s.status as StepStatus,
              }));
            setTask({ title: data.title as string, steps });
          } else {
            setTask(null);
          }
          setLoading(false);
        });
    };

    load();

    // Re-query on any task/step change. agent_task_steps carries no project_id, so we
    // can't filter it server-side here; the re-run query is project-scoped and cheap.
    const channelId = Math.random().toString(36).slice(2);
    const channel = supabase
      .channel(`agent-tasks-${channelId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'agent_tasks' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'agent_task_steps' }, load)
      .subscribe();

    return () => { cancelled = true; supabase.removeChannel(channel); };
  }, [currentProjectId]);

  return { task, loading };
}
