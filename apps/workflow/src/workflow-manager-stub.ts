import { DurableObject } from 'cloudflare:workers';

/**
 * Vestigial stub for the legacy WorkflowManager Durable Object (DQX-26).
 *
 * The real implementation was removed in #25. Cloudflare, however, refuses to
 * deploy a worker version that stops exporting a DO class while that class's
 * namespace still holds stored objects (error 10064), and the delete-class
 * migration that would drop the namespace only applies once no live worker
 * still binds the class (error 10061). #25 tried to do both at once and wedged
 * every deploy.
 *
 * This empty stub keeps the class exported so the rest of the pipeline can ship
 * while the WORKFLOW_MANAGER binding is detached (removed from wrangler.toml).
 * Once this lands, the live worker no longer binds WorkflowManager, and a
 * follow-up deploy deletes this file and adds the `v3` `deleted_classes`
 * migration — which then applies cleanly and drops the namespace for good.
 *
 * Do NOT wire this to a binding or route it any traffic. It exists solely to
 * satisfy the runtime until the delete migration lands.
 */
export class WorkflowManager extends DurableObject {}
