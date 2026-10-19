import { useMemo } from 'react';
import { supabase } from '../lib/supabase';
import { useCurrentProject } from '../context/CurrentProjectContext';
import { useSharedResource, type SubscribeCtx } from '../lib/sharedResource';
import type {
  BuilderFeature,
  CanaryTier,
  FeatureStatus,
  FeatureStep,
  SubFeature,
  UserStory,
} from '../types/builderFeature';

// nff-builder writes `builder_features` (+ child `builder_feature_steps`); the dashboard
// reads them live. Steps live in a separate table, so we attach them to their parent
// feature here. Shapes mirror nff-builder/nff_builder/tools/features/ops.py.

function mapSubFeature(s: Record<string, unknown>): SubFeature {
  return { title: (s.title as string) ?? '', description: (s.description as string) ?? '' };
}

function mapUserStory(s: Record<string, unknown>): UserStory {
  return {
    asA: (s.as_a as string) ?? '',
    iWant: (s.i_want as string) ?? '',
    soThat: (s.so_that as string) ?? '',
  };
}

function mapStepRow(row: Record<string, unknown>): FeatureStep {
  return {
    label: (row.label as string) ?? '',
    status: ((row.status as FeatureStep['status'] | null) ?? 'pending'),
  };
}

// Map a builder_features row to a feature. Steps are filled separately (separate table).
function mapFeatureRow(row: Record<string, unknown>): BuilderFeature {
  const subs = Array.isArray(row.sub_features) ? (row.sub_features as Record<string, unknown>[]) : [];
  const stories = Array.isArray(row.user_stories) ? (row.user_stories as Record<string, unknown>[]) : [];
  return {
    id: row.id as string,
    projectId: (row.project_id as string | null) ?? '',
    sessionId: (row.session_id as string | null) ?? null,
    title: (row.title as string) ?? '',
    description: (row.description as string) ?? '',
    architecture: (row.architecture as string) ?? '',
    subFeatures: subs.map(mapSubFeature),
    userStories: stories.map(mapUserStory),
    steps: [],
    status: ((row.status as FeatureStatus | null) ?? 'draft'),
    priority: (row.priority as number | null) ?? 100,
    repoFullName: (row.repo_full_name as string | null) ?? null,
    branchName: (row.branch_name as string | null) ?? null,
    canaryTier: (row.canary_tier as CanaryTier | null) ?? null,
    canaryDeviceIds: Array.isArray(row.canary_device_ids) ? (row.canary_device_ids as string[]) : [],
    prNumber: (row.pr_number as number | null) ?? null,
    prUrl: (row.pr_url as string | null) ?? null,
    awaitingInput: (row.awaiting_input as boolean | null) ?? false,
    pendingQuestion: (row.pending_question as string | null) ?? null,
    createdAt: row.created_at ? new Date(row.created_at as string) : null,
    updatedAt: row.updated_at ? new Date(row.updated_at as string) : null,
  };
}

const byPriority = (a: BuilderFeature, b: BuilderFeature) =>
  a.priority - b.priority || a.title.localeCompare(b.title);

const keyFor = (projectId: string) => `builder_features:${projectId}`;

// Steps for the given feature ids, grouped by feature. Returns null when the query failed, so a
// caller reconciling live rows can keep the steps it already has rather than blanking checklists.
async function fetchStepsByFeature(featureIds: string[]): Promise<Map<string, FeatureStep[]> | null> {
  const byFeature = new Map<string, FeatureStep[]>();
  if (featureIds.length === 0) return byFeature;
  const { data, error: err } = await supabase
    .from('builder_feature_steps')
    .select('*')
    .in('feature_id', featureIds)
    .order('idx');
  if (err) return null;
  for (const row of data ?? []) {
    const fid = (row as Record<string, unknown>).feature_id as string;
    const arr = byFeature.get(fid) ?? [];
    arr.push(mapStepRow(row as Record<string, unknown>));
    byFeature.set(fid, arr);
  }
  return byFeature;
}

// Features + their steps in two queries, then attach.
async function fetchFeatures(projectId: string): Promise<BuilderFeature[]> {
  const { data: featRows, error: featErr } = await supabase
    .from('builder_features')
    .select('*')
    .eq('project_id', projectId)
    .order('priority');
  if (featErr) throw new Error(featErr.message);

  const mapped = (featRows ?? []).map(r => mapFeatureRow(r as Record<string, unknown>));
  const byFeature = await fetchStepsByFeature(mapped.map(f => f.id));
  for (const f of mapped) f.steps = byFeature?.get(f.id) ?? [];
  return mapped.sort(byPriority);
}

// Re-read all steps for the given feature ids and merge them in. Used on any step-table
// change: a DELETE payload carries only the row id (not feature_id) under the default
// replica identity, so re-querying is the robust way to keep checklists in sync.
async function reloadSteps(ctx: SubscribeCtx<BuilderFeature[]>, featureIds: string[]) {
  if (featureIds.length === 0) return;
  const byFeature = await fetchStepsByFeature(featureIds);
  if (!byFeature) return;
  ctx.mutate(prev =>
    (prev ?? []).map(f => (featureIds.includes(f.id) ? { ...f, steps: byFeature.get(f.id) ?? [] } : f)),
  );
}

export function useBuilderFeatures() {
  const { currentProjectId } = useCurrentProject();
  const key = currentProjectId ? keyFor(currentProjectId) : null;

  const { data, loading, error } = useSharedResource<BuilderFeature[]>(key, {
    fetcher: () => fetchFeatures(currentProjectId),
    subscribe: ctx => {
      const channelId = Math.random().toString(36).slice(2);
      const channel = supabase
        .channel(`builder-${channelId}`)
        // Feature rows for this project. Keep existing steps on UPDATE (steps arrive on the
        // steps channel); reload steps for a freshly inserted feature.
        .on('postgres_changes', { event: '*', schema: 'public', table: 'builder_features', filter: `project_id=eq.${currentProjectId}` }, payload => {
          if (payload.eventType === 'INSERT') {
            const feat = mapFeatureRow(payload.new as Record<string, unknown>);
            ctx.mutate(prev => [...(prev ?? []).filter(f => f.id !== feat.id), feat].sort(byPriority));
            void reloadSteps(ctx, [feat.id]);
          } else if (payload.eventType === 'UPDATE') {
            const feat = mapFeatureRow(payload.new as Record<string, unknown>);
            ctx.mutate(prev =>
              (prev ?? []).map(f => (f.id === feat.id ? { ...feat, steps: f.steps } : f)).sort(byPriority),
            );
          } else if (payload.eventType === 'DELETE') {
            const deletedId = (payload.old as Record<string, unknown>).id as string;
            ctx.mutate(prev => (prev ?? []).filter(f => f.id !== deletedId));
          }
        })
        // Step rows are scoped to this project's features via RLS, but the payload isn't
        // project-filterable, so re-read steps for all known features on any change. The ids come
        // out of the shared cache through a no-op mutate (returning `prev` unchanged notifies
        // nobody) — that replaces the `featuresRef` mirror this hook used to keep, which only
        // existed because a realtime callback closed over stale state.
        .on('postgres_changes', { event: '*', schema: 'public', table: 'builder_feature_steps' }, () => {
          let ids: string[] = [];
          ctx.mutate(prev => { ids = (prev ?? []).map(f => f.id); return prev; });
          void reloadSteps(ctx, ids);
        })
        .subscribe();

      return () => { supabase.removeChannel(channel); };
    },
  });

  const features = useMemo(() => data ?? [], [data]);

  // ─── Light controls — direct UPDATEs (RLS allows authenticated project members). The
  // realtime subscription reflects the change back, so we don't mutate local state here.
  // These mirror nff-builder's set_feature_priority / set_feature_status / set_feature_canary.

  async function setFeaturePriority(id: string, priority: number) {
    const { error: err } = await supabase
      .from('builder_features')
      .update({ priority })
      .eq('id', id);
    if (err) throw new Error(err.message);
  }

  async function setFeatureStatus(id: string, status: FeatureStatus) {
    const { error: err } = await supabase
      .from('builder_features')
      .update({ status })
      .eq('id', id);
    if (err) throw new Error(err.message);
  }

  async function setFeatureCanary(id: string, tier: CanaryTier, deviceIds: string[]) {
    const { error: err } = await supabase
      .from('builder_features')
      .update({ canary_tier: tier, canary_device_ids: deviceIds })
      .eq('id', id);
    if (err) throw new Error(err.message);
  }

  // ─── Cancel / Remove ─────────────────────────────────────────────────────────
  // The GitHub branch is deleted server-side (api/github?action=delete-feature-branch:
  // the function re-reads the row under this JWT, so repo/branch never come from the
  // client, and nff-github refuses anything outside nff-feature/* / nff-fix/*).

  async function deleteFeatureBranch(id: string): Promise<void> {
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    if (!token) throw new Error('not signed in');
    const res = await fetch('/api/github/delete-feature-branch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ feature_id: id }),
    });
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    if (!res.ok) throw new Error(body?.error ?? `branch cleanup failed (${res.status})`);
  }

  /** Cancel: clean up the branch, keep the row as an `abandoned` audit trail. */
  async function cancelFeature(feature: BuilderFeature): Promise<void> {
    if (feature.branchName) await deleteFeatureBranch(feature.id);
    await setFeatureStatus(feature.id, 'abandoned');
  }

  /** Remove: clean up the branch, then hard-delete the row (steps cascade). */
  async function deleteFeature(feature: BuilderFeature): Promise<void> {
    if (feature.branchName) await deleteFeatureBranch(feature.id);
    const { error: err } = await supabase.from('builder_features').delete().eq('id', feature.id);
    if (err) throw new Error(err.message);
  }

  return {
    features, loading, error,
    setFeaturePriority, setFeatureStatus, setFeatureCanary,
    cancelFeature, deleteFeature,
  };
}
