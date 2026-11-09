// Generated from docs/openapi.json (version 0.1.0) by `npm run clients:generate`. Do not edit.
/* eslint-disable */

export type Blueprint = {
  identifier: string;
  title: string;
  description?: string;
  icon?: string | null;
  schema?: {
    properties?: {
      [key: string]: Blueprint_schema0;
    };
    required?: Array<string>;
    order?: Array<string>;
  };
  relations?: {
    [key: string]: {
      title?: string;
      target: string;
      many?: boolean;
      required?: boolean;
      onDelete?: "restrict" | "cascade" | "detach" | "ignore";
      inverseTitle?: string;
      requireExisting?: boolean;
    };
  };
  computed?: {
    [key: string]: {
      kind: "calculated";
      title?: string;
      expression: string;
    } | {
      kind: "mirror";
      title?: string;
      relation: string;
      property?: string;
    } | {
      kind: "aggregation";
      title?: string;
      blueprint: string;
      relation: string;
      function: "count" | "sum" | "min" | "max";
      property?: string;
      filter?: string;
    };
  };
  permissions?: {
    read?: {
      roles?: Array<string>;
      teams?: Array<string>;
      users?: Array<string>;
      ownerTeam?: boolean;
    };
    write?: {
      roles?: Array<string>;
      teams?: Array<string>;
      users?: Array<string>;
      ownerTeam?: boolean;
    };
    delete?: {
      roles?: Array<string>;
      teams?: Array<string>;
      users?: Array<string>;
      ownerTeam?: boolean;
    };
    run?: {
      roles?: Array<string>;
      teams?: Array<string>;
      users?: Array<string>;
      ownerTeam?: boolean;
    };
  };
  ttlProperty?: string | null;
};

export type Action = {
  identifier: string;
  title: string;
  description?: string;
  icon?: string | null;
  trigger?: {
    type: "form";
    on?: "create" | "day-2" | "delete";
    blueprint?: string | null;
    inputs?: {
      properties?: {
        [key: string]: Action_schema0;
      };
      required?: Array<string>;
      order?: Array<string>;
    };
    allowed?: {
      roles?: Array<string>;
      teams?: Array<string>;
      users?: Array<string>;
      ownerTeam?: boolean;
    };
    approval?: {
      required?: boolean;
      approvers?: {
        roles?: Array<string>;
        teams?: Array<string>;
        users?: Array<string>;
        ownerTeam?: boolean;
      };
      minApprovals?: number;
      allowSelfApproval?: boolean;
      remindEvery?: string;
      maxReminders?: number;
      escalate?: {
        after: string;
        approvers: {
          roles?: Array<string>;
          teams?: Array<string>;
          users?: Array<string>;
          ownerTeam?: boolean;
        };
      };
      onExpiry?: "fail" | "reject" | "approve" | "skip";
      expireAfter?: string;
    };
  } | {
    type: "api";
    on?: "create" | "day-2" | "delete";
    blueprint?: string | null;
    inputs?: {
      properties?: {
        [key: string]: Action_schema0;
      };
      required?: Array<string>;
      order?: Array<string>;
    };
    allowed?: {
      roles?: Array<string>;
      teams?: Array<string>;
      users?: Array<string>;
      ownerTeam?: boolean;
    };
    approval?: {
      required?: boolean;
      approvers?: {
        roles?: Array<string>;
        teams?: Array<string>;
        users?: Array<string>;
        ownerTeam?: boolean;
      };
      minApprovals?: number;
      allowSelfApproval?: boolean;
      remindEvery?: string;
      maxReminders?: number;
      escalate?: {
        after: string;
        approvers: {
          roles?: Array<string>;
          teams?: Array<string>;
          users?: Array<string>;
          ownerTeam?: boolean;
        };
      };
      onExpiry?: "fail" | "reject" | "approve" | "skip";
      expireAfter?: string;
    };
  } | {
    type: "schedule";
    cron: string;
    timezone?: string;
    inputs?: {
      [key: string]: unknown;
    };
    catchUp?: "none" | "last" | "all";
    maxCatchUp?: number;
    entities?: {
      blueprint: string;
      filter?: string;
      limit?: number;
    };
  } | {
    type: "event";
    event: "entity.created" | "entity.updated" | "entity.deleted" | "entity.expired" | "scorecard.changed" | "run.finished";
    blueprint?: string | null;
    action?: string | null;
    filter?: string;
    entity?: string;
    inputs?: {
      [key: string]: unknown;
    };
  } | {
    type: "webhook";
    secret: string;
    signatureHeader?: string;
    blueprint?: string | null;
    entity?: string;
    inputs?: {
      [key: string]: unknown;
    };
  } | null;
  invoker?: {
    type: string;
    [key: string]: unknown;
  };
  steps?: Array<{
    id: string;
    name?: string;
    if?: string;
    needs?: Array<string>;
    retries?: number;
    retryDelaySeconds?: number;
    timeoutMinutes?: number;
    continueOnError?: boolean;
    outputSchema?: {
      properties?: {
        [key: string]: Action_schema0;
      };
      required?: Array<string>;
      order?: Array<string>;
    };
    slaMinutes?: number;
    when?: "success" | "failure" | "always";
    onTimeout?: "fail" | "skip" | "continue";
    case?: string | Array<string>;
    type: "invoke";
    invoker: {
      type: string;
      [key: string]: unknown;
    };
    forEach?: {
      items: string;
      maxConcurrency?: number;
      failFast?: boolean;
    };
  } | {
    id: string;
    name?: string;
    if?: string;
    needs?: Array<string>;
    retries?: number;
    retryDelaySeconds?: number;
    timeoutMinutes?: number;
    continueOnError?: boolean;
    outputSchema?: {
      properties?: {
        [key: string]: Action_schema0;
      };
      required?: Array<string>;
      order?: Array<string>;
    };
    slaMinutes?: number;
    when?: "success" | "failure" | "always";
    onTimeout?: "fail" | "skip" | "continue";
    case?: string | Array<string>;
    type: "approval";
    approvers?: {
      roles?: Array<string>;
      teams?: Array<string>;
      users?: Array<string>;
      ownerTeam?: boolean;
    };
    choices?: Array<string>;
    fields?: {
      properties?: {
        [key: string]: Action_schema0;
      };
      required?: Array<string>;
      order?: Array<string>;
    };
    minApprovals?: number;
    allowSelfApproval?: boolean;
    message?: string;
    tiers?: Array<{
      name: string;
      approvers?: {
        roles?: Array<string>;
        teams?: Array<string>;
        users?: Array<string>;
        ownerTeam?: boolean;
      };
      minApprovals?: number;
    }>;
    remindEvery?: string;
    maxReminders?: number;
    escalate?: {
      after: string;
      approvers: {
        roles?: Array<string>;
        teams?: Array<string>;
        users?: Array<string>;
        ownerTeam?: boolean;
      };
    };
    onExpiry?: "fail" | "reject" | "approve" | "skip";
  } | {
    id: string;
    name?: string;
    if?: string;
    needs?: Array<string>;
    retries?: number;
    retryDelaySeconds?: number;
    timeoutMinutes?: number;
    continueOnError?: boolean;
    outputSchema?: {
      properties?: {
        [key: string]: Action_schema0;
      };
      required?: Array<string>;
      order?: Array<string>;
    };
    slaMinutes?: number;
    when?: "success" | "failure" | "always";
    onTimeout?: "fail" | "skip" | "continue";
    case?: string | Array<string>;
    type: "agent";
    model?: string;
    effort?: "low" | "medium" | "high" | "xhigh" | "max";
    system?: string;
    prompt: string;
    output?: {
      properties: {
        [key: string]: {
          [key: string]: unknown;
        };
      };
      required?: Array<string>;
      order?: Array<string>;
    };
    tools?: Array<"catalog" | "upsert_entity" | "trigger_action" | "http">;
    guardrails?: {
      entityBlueprints?: Array<string>;
      actions?: Array<string>;
      httpHosts?: Array<string>;
      httpMethods?: Array<"GET" | "POST" | "PUT" | "PATCH" | "DELETE">;
      maxWrites?: number;
    };
    mcpServers?: Array<{
      name: string;
      url: string;
      token?: string;
      allowedTools?: Array<string>;
    }>;
    maxTurns?: number;
    maxTokens?: number;
    maxCostUsd?: number;
    provider?: "anthropic" | "bedrock" | "vertex";
    apiKey?: string;
    forEach?: {
      items: string;
      maxConcurrency?: number;
      failFast?: boolean;
    };
  } | {
    id: string;
    name?: string;
    if?: string;
    needs?: Array<string>;
    retries?: number;
    retryDelaySeconds?: number;
    timeoutMinutes?: number;
    continueOnError?: boolean;
    outputSchema?: {
      properties?: {
        [key: string]: Action_schema0;
      };
      required?: Array<string>;
      order?: Array<string>;
    };
    slaMinutes?: number;
    when?: "success" | "failure" | "always";
    onTimeout?: "fail" | "skip" | "continue";
    case?: string | Array<string>;
    type: "wait";
    duration?: string;
    until?: string;
    event?: {
      name: string;
      filter?: string;
    };
  } | {
    id: string;
    name?: string;
    if?: string;
    needs?: Array<string>;
    retries?: number;
    retryDelaySeconds?: number;
    timeoutMinutes?: number;
    continueOnError?: boolean;
    outputSchema?: {
      properties?: {
        [key: string]: Action_schema0;
      };
      required?: Array<string>;
      order?: Array<string>;
    };
    slaMinutes?: number;
    when?: "success" | "failure" | "always";
    onTimeout?: "fail" | "skip" | "continue";
    case?: string | Array<string>;
    type: "input";
    message?: string;
    inputs?: {
      properties?: {
        [key: string]: Action_schema0;
      };
      required?: Array<string>;
      order?: Array<string>;
    };
    assignees?: {
      roles?: Array<string>;
      teams?: Array<string>;
      users?: Array<string>;
      ownerTeam?: boolean;
    };
    remindEvery?: string;
    maxReminders?: number;
  } | {
    id: string;
    name?: string;
    if?: string;
    needs?: Array<string>;
    retries?: number;
    retryDelaySeconds?: number;
    timeoutMinutes?: number;
    continueOnError?: boolean;
    outputSchema?: {
      properties?: {
        [key: string]: Action_schema0;
      };
      required?: Array<string>;
      order?: Array<string>;
    };
    slaMinutes?: number;
    when?: "success" | "failure" | "always";
    onTimeout?: "fail" | "skip" | "continue";
    case?: string | Array<string>;
    type: "workflow";
    action: string;
    inputs?: {
      [key: string]: unknown;
    };
    entity?: string;
    forEach?: {
      items: string;
      maxConcurrency?: number;
      failFast?: boolean;
    };
  } | {
    id: string;
    name?: string;
    if?: string;
    needs?: Array<string>;
    retries?: number;
    retryDelaySeconds?: number;
    timeoutMinutes?: number;
    continueOnError?: boolean;
    outputSchema?: {
      properties?: {
        [key: string]: Action_schema0;
      };
      required?: Array<string>;
      order?: Array<string>;
    };
    slaMinutes?: number;
    when?: "success" | "failure" | "always";
    onTimeout?: "fail" | "skip" | "continue";
    case?: string | Array<string>;
    type: "transform";
    output: {
      [key: string]: string;
    };
    forEach?: {
      items: string;
      maxConcurrency?: number;
      failFast?: boolean;
    };
  } | {
    id: string;
    name?: string;
    if?: string;
    needs?: Array<string>;
    retries?: number;
    retryDelaySeconds?: number;
    timeoutMinutes?: number;
    continueOnError?: boolean;
    outputSchema?: {
      properties?: {
        [key: string]: Action_schema0;
      };
      required?: Array<string>;
      order?: Array<string>;
    };
    slaMinutes?: number;
    when?: "success" | "failure" | "always";
    onTimeout?: "fail" | "skip" | "continue";
    case?: string | Array<string>;
    type: "switch";
    cases: Array<{
      id: string;
      when: string;
    }>;
    default?: string;
  } | {
    id: string;
    name?: string;
    if?: string;
    needs?: Array<string>;
    retries?: number;
    retryDelaySeconds?: number;
    timeoutMinutes?: number;
    continueOnError?: boolean;
    outputSchema?: {
      properties?: {
        [key: string]: Action_schema0;
      };
      required?: Array<string>;
      order?: Array<string>;
    };
    slaMinutes?: number;
    when?: "success" | "failure" | "always";
    onTimeout?: "fail" | "skip" | "continue";
    case?: string | Array<string>;
    type: "fragment";
    fragment: string;
    with?: {
      [key: string]: unknown;
    };
  }>;
  secrets?: Array<string>;
  enabled?: boolean;
  blackouts?: Array<{
    name?: string;
    cron?: string;
    duration?: string;
    from?: string;
    to?: string;
    timezone?: string;
  }>;
  blackoutMode?: "skip" | "defer";
  slaMinutes?: number;
  tests?: Array<{
    name: string;
    inputs?: {
      [key: string]: unknown;
    };
    entity?: string | null;
    mocks?: {
      [key: string]: {
        status?: "SUCCESS" | "FAILURE";
        output?: unknown;
      };
    };
    expect?: {
      status?: "SUCCESS" | "FAILURE";
      steps?: {
        [key: string]: {
          status?: "SUCCESS" | "FAILURE" | "SKIPPED";
          output?: unknown;
        };
      };
      outputs?: {
        [key: string]: unknown;
      };
    };
  }>;
  concurrency?: {
    group?: string;
    max?: number;
    mode?: "queue" | "cancel-in-progress" | "reject";
  };
  priority?: number;
  vars?: {
    [key: string]: unknown;
  };
  outputs?: {
    [key: string]: unknown;
  };
};

export type Integration = {
  identifier: string;
  title: string;
  type: string;
  enabled?: boolean;
  config?: {
    [key: string]: unknown;
  };
  mappings?: Array<{
    kind?: string;
    filter?: string;
    items?: string;
    delete?: string;
    merge?: boolean;
    prune?: {
      relation: string;
      value: string;
    };
    entity: {
      blueprint: string;
      identifier: string;
      title?: string;
      team?: string;
      properties?: {
        [key: string]: string;
      };
      relations?: {
        [key: string]: string;
      };
    };
  }>;
  intervalMinutes?: number;
  deleteMissing?: boolean;
  priority?: number;
  primaryFor?: Array<string>;
  schedule?: string;
  deleteMaxPercent?: number;
  deleteDryRun?: boolean;
};

export type Webhook = {
  identifier: string;
  title: string;
  url: string;
  events: Array<string>;
  blueprints?: Array<string>;
  secret?: string | null;
  secondarySecret?: string | null;
  headers?: {
    [key: string]: string;
  };
  filter?: string | null;
  transform?: string | null;
  enabled?: boolean;
};

export type Team = {
  identifier: string;
  title: string;
  description?: string;
  entraGroupId?: string | null;
};

export type Policy = {
  identifier: string;
  title: string;
  description?: string;
  enabled?: boolean;
  target: "run" | "entity";
  match?: {
    actions?: Array<string>;
    blueprints?: Array<string>;
    operations?: Array<"create" | "update" | "delete">;
  };
  expression: string;
  message?: string;
};

export type Fragment = {
  identifier: string;
  title: string;
  description?: string;
  params?: {
    properties?: {
      [key: string]: Fragment_schema0;
    };
    required?: Array<string>;
    order?: Array<string>;
  };
  steps: Array<{
    id: string;
    name?: string;
    if?: string;
    needs?: Array<string>;
    retries?: number;
    retryDelaySeconds?: number;
    timeoutMinutes?: number;
    continueOnError?: boolean;
    outputSchema?: {
      properties?: {
        [key: string]: Fragment_schema0;
      };
      required?: Array<string>;
      order?: Array<string>;
    };
    slaMinutes?: number;
    when?: "success" | "failure" | "always";
    onTimeout?: "fail" | "skip" | "continue";
    case?: string | Array<string>;
    type: "invoke";
    invoker: {
      type: string;
      [key: string]: unknown;
    };
    forEach?: {
      items: string;
      maxConcurrency?: number;
      failFast?: boolean;
    };
  } | {
    id: string;
    name?: string;
    if?: string;
    needs?: Array<string>;
    retries?: number;
    retryDelaySeconds?: number;
    timeoutMinutes?: number;
    continueOnError?: boolean;
    outputSchema?: {
      properties?: {
        [key: string]: Fragment_schema0;
      };
      required?: Array<string>;
      order?: Array<string>;
    };
    slaMinutes?: number;
    when?: "success" | "failure" | "always";
    onTimeout?: "fail" | "skip" | "continue";
    case?: string | Array<string>;
    type: "approval";
    approvers?: {
      roles?: Array<string>;
      teams?: Array<string>;
      users?: Array<string>;
      ownerTeam?: boolean;
    };
    choices?: Array<string>;
    fields?: {
      properties?: {
        [key: string]: Fragment_schema0;
      };
      required?: Array<string>;
      order?: Array<string>;
    };
    minApprovals?: number;
    allowSelfApproval?: boolean;
    message?: string;
    tiers?: Array<{
      name: string;
      approvers?: {
        roles?: Array<string>;
        teams?: Array<string>;
        users?: Array<string>;
        ownerTeam?: boolean;
      };
      minApprovals?: number;
    }>;
    remindEvery?: string;
    maxReminders?: number;
    escalate?: {
      after: string;
      approvers: {
        roles?: Array<string>;
        teams?: Array<string>;
        users?: Array<string>;
        ownerTeam?: boolean;
      };
    };
    onExpiry?: "fail" | "reject" | "approve" | "skip";
  } | {
    id: string;
    name?: string;
    if?: string;
    needs?: Array<string>;
    retries?: number;
    retryDelaySeconds?: number;
    timeoutMinutes?: number;
    continueOnError?: boolean;
    outputSchema?: {
      properties?: {
        [key: string]: Fragment_schema0;
      };
      required?: Array<string>;
      order?: Array<string>;
    };
    slaMinutes?: number;
    when?: "success" | "failure" | "always";
    onTimeout?: "fail" | "skip" | "continue";
    case?: string | Array<string>;
    type: "agent";
    model?: string;
    effort?: "low" | "medium" | "high" | "xhigh" | "max";
    system?: string;
    prompt: string;
    output?: {
      properties: {
        [key: string]: {
          [key: string]: unknown;
        };
      };
      required?: Array<string>;
      order?: Array<string>;
    };
    tools?: Array<"catalog" | "upsert_entity" | "trigger_action" | "http">;
    guardrails?: {
      entityBlueprints?: Array<string>;
      actions?: Array<string>;
      httpHosts?: Array<string>;
      httpMethods?: Array<"GET" | "POST" | "PUT" | "PATCH" | "DELETE">;
      maxWrites?: number;
    };
    mcpServers?: Array<{
      name: string;
      url: string;
      token?: string;
      allowedTools?: Array<string>;
    }>;
    maxTurns?: number;
    maxTokens?: number;
    maxCostUsd?: number;
    provider?: "anthropic" | "bedrock" | "vertex";
    apiKey?: string;
    forEach?: {
      items: string;
      maxConcurrency?: number;
      failFast?: boolean;
    };
  } | {
    id: string;
    name?: string;
    if?: string;
    needs?: Array<string>;
    retries?: number;
    retryDelaySeconds?: number;
    timeoutMinutes?: number;
    continueOnError?: boolean;
    outputSchema?: {
      properties?: {
        [key: string]: Fragment_schema0;
      };
      required?: Array<string>;
      order?: Array<string>;
    };
    slaMinutes?: number;
    when?: "success" | "failure" | "always";
    onTimeout?: "fail" | "skip" | "continue";
    case?: string | Array<string>;
    type: "wait";
    duration?: string;
    until?: string;
    event?: {
      name: string;
      filter?: string;
    };
  } | {
    id: string;
    name?: string;
    if?: string;
    needs?: Array<string>;
    retries?: number;
    retryDelaySeconds?: number;
    timeoutMinutes?: number;
    continueOnError?: boolean;
    outputSchema?: {
      properties?: {
        [key: string]: Fragment_schema0;
      };
      required?: Array<string>;
      order?: Array<string>;
    };
    slaMinutes?: number;
    when?: "success" | "failure" | "always";
    onTimeout?: "fail" | "skip" | "continue";
    case?: string | Array<string>;
    type: "input";
    message?: string;
    inputs?: {
      properties?: {
        [key: string]: Fragment_schema0;
      };
      required?: Array<string>;
      order?: Array<string>;
    };
    assignees?: {
      roles?: Array<string>;
      teams?: Array<string>;
      users?: Array<string>;
      ownerTeam?: boolean;
    };
    remindEvery?: string;
    maxReminders?: number;
  } | {
    id: string;
    name?: string;
    if?: string;
    needs?: Array<string>;
    retries?: number;
    retryDelaySeconds?: number;
    timeoutMinutes?: number;
    continueOnError?: boolean;
    outputSchema?: {
      properties?: {
        [key: string]: Fragment_schema0;
      };
      required?: Array<string>;
      order?: Array<string>;
    };
    slaMinutes?: number;
    when?: "success" | "failure" | "always";
    onTimeout?: "fail" | "skip" | "continue";
    case?: string | Array<string>;
    type: "workflow";
    action: string;
    inputs?: {
      [key: string]: unknown;
    };
    entity?: string;
    forEach?: {
      items: string;
      maxConcurrency?: number;
      failFast?: boolean;
    };
  } | {
    id: string;
    name?: string;
    if?: string;
    needs?: Array<string>;
    retries?: number;
    retryDelaySeconds?: number;
    timeoutMinutes?: number;
    continueOnError?: boolean;
    outputSchema?: {
      properties?: {
        [key: string]: Fragment_schema0;
      };
      required?: Array<string>;
      order?: Array<string>;
    };
    slaMinutes?: number;
    when?: "success" | "failure" | "always";
    onTimeout?: "fail" | "skip" | "continue";
    case?: string | Array<string>;
    type: "transform";
    output: {
      [key: string]: string;
    };
    forEach?: {
      items: string;
      maxConcurrency?: number;
      failFast?: boolean;
    };
  } | {
    id: string;
    name?: string;
    if?: string;
    needs?: Array<string>;
    retries?: number;
    retryDelaySeconds?: number;
    timeoutMinutes?: number;
    continueOnError?: boolean;
    outputSchema?: {
      properties?: {
        [key: string]: Fragment_schema0;
      };
      required?: Array<string>;
      order?: Array<string>;
    };
    slaMinutes?: number;
    when?: "success" | "failure" | "always";
    onTimeout?: "fail" | "skip" | "continue";
    case?: string | Array<string>;
    type: "switch";
    cases: Array<{
      id: string;
      when: string;
    }>;
    default?: string;
  } | {
    id: string;
    name?: string;
    if?: string;
    needs?: Array<string>;
    retries?: number;
    retryDelaySeconds?: number;
    timeoutMinutes?: number;
    continueOnError?: boolean;
    outputSchema?: {
      properties?: {
        [key: string]: Fragment_schema0;
      };
      required?: Array<string>;
      order?: Array<string>;
    };
    slaMinutes?: number;
    when?: "success" | "failure" | "always";
    onTimeout?: "fail" | "skip" | "continue";
    case?: string | Array<string>;
    type: "fragment";
    fragment: string;
    with?: {
      [key: string]: unknown;
    };
  }>;
  outputs?: {
    [key: string]: string;
  };
};

export type EntityInput = {
  identifier: string;
  title?: string;
  team?: string | null;
  properties?: {
    [key: string]: unknown;
  };
  relations?: {
    [key: string]: string | Array<string> | null;
  };
};

export type DelegationInput = {
  delegate: string;
  startsAt?: string | null;
  endsAt?: string | null;
};

export type ConfigFile = {
  organizations?: Array<{
    slug: string;
    name: string;
    domains?: Array<string>;
    admins?: Array<string>;
  }>;
  teams?: Array<{
    identifier: string;
    title: string;
    description?: string;
    entraGroupId?: string | null;
  }>;
  blueprints?: Array<{
    identifier: string;
    title: string;
    description?: string;
    icon?: string | null;
    schema?: {
      properties?: {
        [key: string]: ConfigFile_schema0;
      };
      required?: Array<string>;
      order?: Array<string>;
    };
    relations?: {
      [key: string]: {
        title?: string;
        target: string;
        many?: boolean;
        required?: boolean;
        onDelete?: "restrict" | "cascade" | "detach" | "ignore";
        inverseTitle?: string;
        requireExisting?: boolean;
      };
    };
    computed?: {
      [key: string]: {
        kind: "calculated";
        title?: string;
        expression: string;
      } | {
        kind: "mirror";
        title?: string;
        relation: string;
        property?: string;
      } | {
        kind: "aggregation";
        title?: string;
        blueprint: string;
        relation: string;
        function: "count" | "sum" | "min" | "max";
        property?: string;
        filter?: string;
      };
    };
    permissions?: {
      read?: {
        roles?: Array<string>;
        teams?: Array<string>;
        users?: Array<string>;
        ownerTeam?: boolean;
      };
      write?: {
        roles?: Array<string>;
        teams?: Array<string>;
        users?: Array<string>;
        ownerTeam?: boolean;
      };
      delete?: {
        roles?: Array<string>;
        teams?: Array<string>;
        users?: Array<string>;
        ownerTeam?: boolean;
      };
      run?: {
        roles?: Array<string>;
        teams?: Array<string>;
        users?: Array<string>;
        ownerTeam?: boolean;
      };
    };
    ttlProperty?: string | null;
  }>;
  actions?: Array<{
    identifier: string;
    title: string;
    description?: string;
    icon?: string | null;
    trigger?: {
      type: "form";
      on?: "create" | "day-2" | "delete";
      blueprint?: string | null;
      inputs?: {
        properties?: {
          [key: string]: ConfigFile_schema0;
        };
        required?: Array<string>;
        order?: Array<string>;
      };
      allowed?: {
        roles?: Array<string>;
        teams?: Array<string>;
        users?: Array<string>;
        ownerTeam?: boolean;
      };
      approval?: {
        required?: boolean;
        approvers?: {
          roles?: Array<string>;
          teams?: Array<string>;
          users?: Array<string>;
          ownerTeam?: boolean;
        };
        minApprovals?: number;
        allowSelfApproval?: boolean;
        remindEvery?: string;
        maxReminders?: number;
        escalate?: {
          after: string;
          approvers: {
            roles?: Array<string>;
            teams?: Array<string>;
            users?: Array<string>;
            ownerTeam?: boolean;
          };
        };
        onExpiry?: "fail" | "reject" | "approve" | "skip";
        expireAfter?: string;
      };
    } | {
      type: "api";
      on?: "create" | "day-2" | "delete";
      blueprint?: string | null;
      inputs?: {
        properties?: {
          [key: string]: ConfigFile_schema0;
        };
        required?: Array<string>;
        order?: Array<string>;
      };
      allowed?: {
        roles?: Array<string>;
        teams?: Array<string>;
        users?: Array<string>;
        ownerTeam?: boolean;
      };
      approval?: {
        required?: boolean;
        approvers?: {
          roles?: Array<string>;
          teams?: Array<string>;
          users?: Array<string>;
          ownerTeam?: boolean;
        };
        minApprovals?: number;
        allowSelfApproval?: boolean;
        remindEvery?: string;
        maxReminders?: number;
        escalate?: {
          after: string;
          approvers: {
            roles?: Array<string>;
            teams?: Array<string>;
            users?: Array<string>;
            ownerTeam?: boolean;
          };
        };
        onExpiry?: "fail" | "reject" | "approve" | "skip";
        expireAfter?: string;
      };
    } | {
      type: "schedule";
      cron: string;
      timezone?: string;
      inputs?: {
        [key: string]: unknown;
      };
      catchUp?: "none" | "last" | "all";
      maxCatchUp?: number;
      entities?: {
        blueprint: string;
        filter?: string;
        limit?: number;
      };
    } | {
      type: "event";
      event: "entity.created" | "entity.updated" | "entity.deleted" | "entity.expired" | "scorecard.changed" | "run.finished";
      blueprint?: string | null;
      action?: string | null;
      filter?: string;
      entity?: string;
      inputs?: {
        [key: string]: unknown;
      };
    } | {
      type: "webhook";
      secret: string;
      signatureHeader?: string;
      blueprint?: string | null;
      entity?: string;
      inputs?: {
        [key: string]: unknown;
      };
    } | null;
    invoker?: {
      type: string;
      [key: string]: unknown;
    };
    steps?: Array<{
      id: string;
      name?: string;
      if?: string;
      needs?: Array<string>;
      retries?: number;
      retryDelaySeconds?: number;
      timeoutMinutes?: number;
      continueOnError?: boolean;
      outputSchema?: {
        properties?: {
          [key: string]: ConfigFile_schema0;
        };
        required?: Array<string>;
        order?: Array<string>;
      };
      slaMinutes?: number;
      when?: "success" | "failure" | "always";
      onTimeout?: "fail" | "skip" | "continue";
      case?: string | Array<string>;
      type: "invoke";
      invoker: {
        type: string;
        [key: string]: unknown;
      };
      forEach?: {
        items: string;
        maxConcurrency?: number;
        failFast?: boolean;
      };
    } | {
      id: string;
      name?: string;
      if?: string;
      needs?: Array<string>;
      retries?: number;
      retryDelaySeconds?: number;
      timeoutMinutes?: number;
      continueOnError?: boolean;
      outputSchema?: {
        properties?: {
          [key: string]: ConfigFile_schema0;
        };
        required?: Array<string>;
        order?: Array<string>;
      };
      slaMinutes?: number;
      when?: "success" | "failure" | "always";
      onTimeout?: "fail" | "skip" | "continue";
      case?: string | Array<string>;
      type: "approval";
      approvers?: {
        roles?: Array<string>;
        teams?: Array<string>;
        users?: Array<string>;
        ownerTeam?: boolean;
      };
      choices?: Array<string>;
      fields?: {
        properties?: {
          [key: string]: ConfigFile_schema0;
        };
        required?: Array<string>;
        order?: Array<string>;
      };
      minApprovals?: number;
      allowSelfApproval?: boolean;
      message?: string;
      tiers?: Array<{
        name: string;
        approvers?: {
          roles?: Array<string>;
          teams?: Array<string>;
          users?: Array<string>;
          ownerTeam?: boolean;
        };
        minApprovals?: number;
      }>;
      remindEvery?: string;
      maxReminders?: number;
      escalate?: {
        after: string;
        approvers: {
          roles?: Array<string>;
          teams?: Array<string>;
          users?: Array<string>;
          ownerTeam?: boolean;
        };
      };
      onExpiry?: "fail" | "reject" | "approve" | "skip";
    } | {
      id: string;
      name?: string;
      if?: string;
      needs?: Array<string>;
      retries?: number;
      retryDelaySeconds?: number;
      timeoutMinutes?: number;
      continueOnError?: boolean;
      outputSchema?: {
        properties?: {
          [key: string]: ConfigFile_schema0;
        };
        required?: Array<string>;
        order?: Array<string>;
      };
      slaMinutes?: number;
      when?: "success" | "failure" | "always";
      onTimeout?: "fail" | "skip" | "continue";
      case?: string | Array<string>;
      type: "agent";
      model?: string;
      effort?: "low" | "medium" | "high" | "xhigh" | "max";
      system?: string;
      prompt: string;
      output?: {
        properties: {
          [key: string]: {
            [key: string]: unknown;
          };
        };
        required?: Array<string>;
        order?: Array<string>;
      };
      tools?: Array<"catalog" | "upsert_entity" | "trigger_action" | "http">;
      guardrails?: {
        entityBlueprints?: Array<string>;
        actions?: Array<string>;
        httpHosts?: Array<string>;
        httpMethods?: Array<"GET" | "POST" | "PUT" | "PATCH" | "DELETE">;
        maxWrites?: number;
      };
      mcpServers?: Array<{
        name: string;
        url: string;
        token?: string;
        allowedTools?: Array<string>;
      }>;
      maxTurns?: number;
      maxTokens?: number;
      maxCostUsd?: number;
      provider?: "anthropic" | "bedrock" | "vertex";
      apiKey?: string;
      forEach?: {
        items: string;
        maxConcurrency?: number;
        failFast?: boolean;
      };
    } | {
      id: string;
      name?: string;
      if?: string;
      needs?: Array<string>;
      retries?: number;
      retryDelaySeconds?: number;
      timeoutMinutes?: number;
      continueOnError?: boolean;
      outputSchema?: {
        properties?: {
          [key: string]: ConfigFile_schema0;
        };
        required?: Array<string>;
        order?: Array<string>;
      };
      slaMinutes?: number;
      when?: "success" | "failure" | "always";
      onTimeout?: "fail" | "skip" | "continue";
      case?: string | Array<string>;
      type: "wait";
      duration?: string;
      until?: string;
      event?: {
        name: string;
        filter?: string;
      };
    } | {
      id: string;
      name?: string;
      if?: string;
      needs?: Array<string>;
      retries?: number;
      retryDelaySeconds?: number;
      timeoutMinutes?: number;
      continueOnError?: boolean;
      outputSchema?: {
        properties?: {
          [key: string]: ConfigFile_schema0;
        };
        required?: Array<string>;
        order?: Array<string>;
      };
      slaMinutes?: number;
      when?: "success" | "failure" | "always";
      onTimeout?: "fail" | "skip" | "continue";
      case?: string | Array<string>;
      type: "input";
      message?: string;
      inputs?: {
        properties?: {
          [key: string]: ConfigFile_schema0;
        };
        required?: Array<string>;
        order?: Array<string>;
      };
      assignees?: {
        roles?: Array<string>;
        teams?: Array<string>;
        users?: Array<string>;
        ownerTeam?: boolean;
      };
      remindEvery?: string;
      maxReminders?: number;
    } | {
      id: string;
      name?: string;
      if?: string;
      needs?: Array<string>;
      retries?: number;
      retryDelaySeconds?: number;
      timeoutMinutes?: number;
      continueOnError?: boolean;
      outputSchema?: {
        properties?: {
          [key: string]: ConfigFile_schema0;
        };
        required?: Array<string>;
        order?: Array<string>;
      };
      slaMinutes?: number;
      when?: "success" | "failure" | "always";
      onTimeout?: "fail" | "skip" | "continue";
      case?: string | Array<string>;
      type: "workflow";
      action: string;
      inputs?: {
        [key: string]: unknown;
      };
      entity?: string;
      forEach?: {
        items: string;
        maxConcurrency?: number;
        failFast?: boolean;
      };
    } | {
      id: string;
      name?: string;
      if?: string;
      needs?: Array<string>;
      retries?: number;
      retryDelaySeconds?: number;
      timeoutMinutes?: number;
      continueOnError?: boolean;
      outputSchema?: {
        properties?: {
          [key: string]: ConfigFile_schema0;
        };
        required?: Array<string>;
        order?: Array<string>;
      };
      slaMinutes?: number;
      when?: "success" | "failure" | "always";
      onTimeout?: "fail" | "skip" | "continue";
      case?: string | Array<string>;
      type: "transform";
      output: {
        [key: string]: string;
      };
      forEach?: {
        items: string;
        maxConcurrency?: number;
        failFast?: boolean;
      };
    } | {
      id: string;
      name?: string;
      if?: string;
      needs?: Array<string>;
      retries?: number;
      retryDelaySeconds?: number;
      timeoutMinutes?: number;
      continueOnError?: boolean;
      outputSchema?: {
        properties?: {
          [key: string]: ConfigFile_schema0;
        };
        required?: Array<string>;
        order?: Array<string>;
      };
      slaMinutes?: number;
      when?: "success" | "failure" | "always";
      onTimeout?: "fail" | "skip" | "continue";
      case?: string | Array<string>;
      type: "switch";
      cases: Array<{
        id: string;
        when: string;
      }>;
      default?: string;
    } | {
      id: string;
      name?: string;
      if?: string;
      needs?: Array<string>;
      retries?: number;
      retryDelaySeconds?: number;
      timeoutMinutes?: number;
      continueOnError?: boolean;
      outputSchema?: {
        properties?: {
          [key: string]: ConfigFile_schema0;
        };
        required?: Array<string>;
        order?: Array<string>;
      };
      slaMinutes?: number;
      when?: "success" | "failure" | "always";
      onTimeout?: "fail" | "skip" | "continue";
      case?: string | Array<string>;
      type: "fragment";
      fragment: string;
      with?: {
        [key: string]: unknown;
      };
    }>;
    secrets?: Array<string>;
    enabled?: boolean;
    blackouts?: Array<{
      name?: string;
      cron?: string;
      duration?: string;
      from?: string;
      to?: string;
      timezone?: string;
    }>;
    blackoutMode?: "skip" | "defer";
    slaMinutes?: number;
    tests?: Array<{
      name: string;
      inputs?: {
        [key: string]: unknown;
      };
      entity?: string | null;
      mocks?: {
        [key: string]: {
          status?: "SUCCESS" | "FAILURE";
          output?: unknown;
        };
      };
      expect?: {
        status?: "SUCCESS" | "FAILURE";
        steps?: {
          [key: string]: {
            status?: "SUCCESS" | "FAILURE" | "SKIPPED";
            output?: unknown;
          };
        };
        outputs?: {
          [key: string]: unknown;
        };
      };
    }>;
    concurrency?: {
      group?: string;
      max?: number;
      mode?: "queue" | "cancel-in-progress" | "reject";
    };
    priority?: number;
    vars?: {
      [key: string]: unknown;
    };
    outputs?: {
      [key: string]: unknown;
    };
  }>;
  integrations?: Array<{
    identifier: string;
    title: string;
    type: string;
    enabled?: boolean;
    config?: {
      [key: string]: unknown;
    };
    mappings?: Array<{
      kind?: string;
      filter?: string;
      items?: string;
      delete?: string;
      merge?: boolean;
      prune?: {
        relation: string;
        value: string;
      };
      entity: {
        blueprint: string;
        identifier: string;
        title?: string;
        team?: string;
        properties?: {
          [key: string]: string;
        };
        relations?: {
          [key: string]: string;
        };
      };
    }>;
    intervalMinutes?: number;
    deleteMissing?: boolean;
    priority?: number;
    primaryFor?: Array<string>;
    schedule?: string;
    deleteMaxPercent?: number;
    deleteDryRun?: boolean;
  }>;
  webhooks?: Array<{
    identifier: string;
    title: string;
    url: string;
    events: Array<string>;
    blueprints?: Array<string>;
    secret?: string | null;
    secondarySecret?: string | null;
    headers?: {
      [key: string]: string;
    };
    filter?: string | null;
    transform?: string | null;
    enabled?: boolean;
  }>;
  scorecards?: Array<{
    identifier: string;
    title: string;
    description?: string;
    blueprint: string;
    levels: Array<{
      name: string;
      color?: string;
    }>;
    rules: Array<{
      identifier: string;
      title: string;
      description?: string;
      level: string;
      expression: string;
    }>;
  }>;
  policies?: Array<{
    identifier: string;
    title: string;
    description?: string;
    enabled?: boolean;
    target: "run" | "entity";
    match?: {
      actions?: Array<string>;
      blueprints?: Array<string>;
      operations?: Array<"create" | "update" | "delete">;
    };
    expression: string;
    message?: string;
  }>;
  dashboards?: Array<{
    identifier: string;
    title: string;
    description?: string;
    team?: string | null;
    blueprint?: string | null;
    default?: boolean;
    widgets?: Array<{
      title?: string;
      width?: number;
      type: "count";
      blueprint: string;
      filters?: {
        [key: string]: string;
      };
      groupBy?: string;
    } | {
      title?: string;
      width?: number;
      type: "scorecard";
      scorecard: string;
    } | {
      title?: string;
      width?: number;
      type: "runs";
      limit?: number;
      mine?: boolean;
      status?: Array<"PENDING_APPROVAL" | "QUEUED" | "IN_PROGRESS" | "SUCCESS" | "FAILURE" | "REJECTED" | "CANCELLED">;
      action?: string;
    } | {
      title?: string;
      width?: number;
      type: "approvals";
      limit?: number;
    } | {
      title?: string;
      width?: number;
      type: "table";
      blueprint: string;
      filters?: {
        [key: string]: string;
      };
      search?: string;
      sort?: "title" | "updated" | "identifier";
      columns?: Array<string>;
      limit?: number;
    } | {
      title?: string;
      width?: number;
      type: "insights";
      days?: number;
      team?: string;
      service?: string;
      deployments?: {
        blueprint?: string;
        timeProperty?: string;
        statusProperty?: string;
        successValues?: Array<string>;
        failureValues?: Array<string>;
        mergedProperty?: string;
        serviceRelation?: string;
      };
      deploymentActions?: Array<string>;
      incidents?: {
        blueprint?: string;
        createdProperty?: string;
        resolvedProperty?: string;
        serviceRelation?: string;
      };
    } | {
      title?: string;
      width?: number;
      type: "markdown";
      content: string;
    }>;
  }>;
  fragments?: Array<{
    identifier: string;
    title: string;
    description?: string;
    params?: {
      properties?: {
        [key: string]: ConfigFile_schema0;
      };
      required?: Array<string>;
      order?: Array<string>;
    };
    steps: Array<{
      id: string;
      name?: string;
      if?: string;
      needs?: Array<string>;
      retries?: number;
      retryDelaySeconds?: number;
      timeoutMinutes?: number;
      continueOnError?: boolean;
      outputSchema?: {
        properties?: {
          [key: string]: ConfigFile_schema0;
        };
        required?: Array<string>;
        order?: Array<string>;
      };
      slaMinutes?: number;
      when?: "success" | "failure" | "always";
      onTimeout?: "fail" | "skip" | "continue";
      case?: string | Array<string>;
      type: "invoke";
      invoker: {
        type: string;
        [key: string]: unknown;
      };
      forEach?: {
        items: string;
        maxConcurrency?: number;
        failFast?: boolean;
      };
    } | {
      id: string;
      name?: string;
      if?: string;
      needs?: Array<string>;
      retries?: number;
      retryDelaySeconds?: number;
      timeoutMinutes?: number;
      continueOnError?: boolean;
      outputSchema?: {
        properties?: {
          [key: string]: ConfigFile_schema0;
        };
        required?: Array<string>;
        order?: Array<string>;
      };
      slaMinutes?: number;
      when?: "success" | "failure" | "always";
      onTimeout?: "fail" | "skip" | "continue";
      case?: string | Array<string>;
      type: "approval";
      approvers?: {
        roles?: Array<string>;
        teams?: Array<string>;
        users?: Array<string>;
        ownerTeam?: boolean;
      };
      choices?: Array<string>;
      fields?: {
        properties?: {
          [key: string]: ConfigFile_schema0;
        };
        required?: Array<string>;
        order?: Array<string>;
      };
      minApprovals?: number;
      allowSelfApproval?: boolean;
      message?: string;
      tiers?: Array<{
        name: string;
        approvers?: {
          roles?: Array<string>;
          teams?: Array<string>;
          users?: Array<string>;
          ownerTeam?: boolean;
        };
        minApprovals?: number;
      }>;
      remindEvery?: string;
      maxReminders?: number;
      escalate?: {
        after: string;
        approvers: {
          roles?: Array<string>;
          teams?: Array<string>;
          users?: Array<string>;
          ownerTeam?: boolean;
        };
      };
      onExpiry?: "fail" | "reject" | "approve" | "skip";
    } | {
      id: string;
      name?: string;
      if?: string;
      needs?: Array<string>;
      retries?: number;
      retryDelaySeconds?: number;
      timeoutMinutes?: number;
      continueOnError?: boolean;
      outputSchema?: {
        properties?: {
          [key: string]: ConfigFile_schema0;
        };
        required?: Array<string>;
        order?: Array<string>;
      };
      slaMinutes?: number;
      when?: "success" | "failure" | "always";
      onTimeout?: "fail" | "skip" | "continue";
      case?: string | Array<string>;
      type: "agent";
      model?: string;
      effort?: "low" | "medium" | "high" | "xhigh" | "max";
      system?: string;
      prompt: string;
      output?: {
        properties: {
          [key: string]: {
            [key: string]: unknown;
          };
        };
        required?: Array<string>;
        order?: Array<string>;
      };
      tools?: Array<"catalog" | "upsert_entity" | "trigger_action" | "http">;
      guardrails?: {
        entityBlueprints?: Array<string>;
        actions?: Array<string>;
        httpHosts?: Array<string>;
        httpMethods?: Array<"GET" | "POST" | "PUT" | "PATCH" | "DELETE">;
        maxWrites?: number;
      };
      mcpServers?: Array<{
        name: string;
        url: string;
        token?: string;
        allowedTools?: Array<string>;
      }>;
      maxTurns?: number;
      maxTokens?: number;
      maxCostUsd?: number;
      provider?: "anthropic" | "bedrock" | "vertex";
      apiKey?: string;
      forEach?: {
        items: string;
        maxConcurrency?: number;
        failFast?: boolean;
      };
    } | {
      id: string;
      name?: string;
      if?: string;
      needs?: Array<string>;
      retries?: number;
      retryDelaySeconds?: number;
      timeoutMinutes?: number;
      continueOnError?: boolean;
      outputSchema?: {
        properties?: {
          [key: string]: ConfigFile_schema0;
        };
        required?: Array<string>;
        order?: Array<string>;
      };
      slaMinutes?: number;
      when?: "success" | "failure" | "always";
      onTimeout?: "fail" | "skip" | "continue";
      case?: string | Array<string>;
      type: "wait";
      duration?: string;
      until?: string;
      event?: {
        name: string;
        filter?: string;
      };
    } | {
      id: string;
      name?: string;
      if?: string;
      needs?: Array<string>;
      retries?: number;
      retryDelaySeconds?: number;
      timeoutMinutes?: number;
      continueOnError?: boolean;
      outputSchema?: {
        properties?: {
          [key: string]: ConfigFile_schema0;
        };
        required?: Array<string>;
        order?: Array<string>;
      };
      slaMinutes?: number;
      when?: "success" | "failure" | "always";
      onTimeout?: "fail" | "skip" | "continue";
      case?: string | Array<string>;
      type: "input";
      message?: string;
      inputs?: {
        properties?: {
          [key: string]: ConfigFile_schema0;
        };
        required?: Array<string>;
        order?: Array<string>;
      };
      assignees?: {
        roles?: Array<string>;
        teams?: Array<string>;
        users?: Array<string>;
        ownerTeam?: boolean;
      };
      remindEvery?: string;
      maxReminders?: number;
    } | {
      id: string;
      name?: string;
      if?: string;
      needs?: Array<string>;
      retries?: number;
      retryDelaySeconds?: number;
      timeoutMinutes?: number;
      continueOnError?: boolean;
      outputSchema?: {
        properties?: {
          [key: string]: ConfigFile_schema0;
        };
        required?: Array<string>;
        order?: Array<string>;
      };
      slaMinutes?: number;
      when?: "success" | "failure" | "always";
      onTimeout?: "fail" | "skip" | "continue";
      case?: string | Array<string>;
      type: "workflow";
      action: string;
      inputs?: {
        [key: string]: unknown;
      };
      entity?: string;
      forEach?: {
        items: string;
        maxConcurrency?: number;
        failFast?: boolean;
      };
    } | {
      id: string;
      name?: string;
      if?: string;
      needs?: Array<string>;
      retries?: number;
      retryDelaySeconds?: number;
      timeoutMinutes?: number;
      continueOnError?: boolean;
      outputSchema?: {
        properties?: {
          [key: string]: ConfigFile_schema0;
        };
        required?: Array<string>;
        order?: Array<string>;
      };
      slaMinutes?: number;
      when?: "success" | "failure" | "always";
      onTimeout?: "fail" | "skip" | "continue";
      case?: string | Array<string>;
      type: "transform";
      output: {
        [key: string]: string;
      };
      forEach?: {
        items: string;
        maxConcurrency?: number;
        failFast?: boolean;
      };
    } | {
      id: string;
      name?: string;
      if?: string;
      needs?: Array<string>;
      retries?: number;
      retryDelaySeconds?: number;
      timeoutMinutes?: number;
      continueOnError?: boolean;
      outputSchema?: {
        properties?: {
          [key: string]: ConfigFile_schema0;
        };
        required?: Array<string>;
        order?: Array<string>;
      };
      slaMinutes?: number;
      when?: "success" | "failure" | "always";
      onTimeout?: "fail" | "skip" | "continue";
      case?: string | Array<string>;
      type: "switch";
      cases: Array<{
        id: string;
        when: string;
      }>;
      default?: string;
    } | {
      id: string;
      name?: string;
      if?: string;
      needs?: Array<string>;
      retries?: number;
      retryDelaySeconds?: number;
      timeoutMinutes?: number;
      continueOnError?: boolean;
      outputSchema?: {
        properties?: {
          [key: string]: ConfigFile_schema0;
        };
        required?: Array<string>;
        order?: Array<string>;
      };
      slaMinutes?: number;
      when?: "success" | "failure" | "always";
      onTimeout?: "fail" | "skip" | "continue";
      case?: string | Array<string>;
      type: "fragment";
      fragment: string;
      with?: {
        [key: string]: unknown;
      };
    }>;
    outputs?: {
      [key: string]: string;
    };
  }>;
  entities?: Array<{
    identifier: string;
    title?: string;
    team?: string | null;
    properties?: {
      [key: string]: unknown;
    };
    relations?: {
      [key: string]: string | Array<string> | null;
    };
    blueprint: string;
  }>;
};

export type Entity = {
  blueprint: string;
  identifier: string;
  title: string;
  team: string | null;
  properties: {
    [key: string]: unknown;
  };
  relations: {
    [key: string]: unknown;
  };
  source: string;
  createdAt: string;
  updatedAt: string;
};

export type Delegation = {
  user: {
    id: string;
    name: string;
    email: string;
  };
  delegate: {
    id: string;
    name: string;
    email: string;
  };
  startsAt: string | null;
  endsAt: string | null;
  active: boolean;
  createdAt: string;
};

export type MyDelegation = {
  delegation: {
    user: {
      id: string;
      name: string;
      email: string;
    };
    delegate: {
      id: string;
      name: string;
      email: string;
    };
    startsAt: string | null;
    endsAt: string | null;
    active: boolean;
    createdAt: string;
  } | null;
};

export type EntityDocs = {
  property: string;
  url: string;
  markdown: string;
};

export type EntityGraph = {
  root: {
    blueprint: string;
    identifier: string;
  };
  nodes: Array<{
    blueprint: string;
    identifier: string;
    title: string;
    team: string | null;
    depth: number;
    missing: boolean;
  }>;
  edges: Array<{
    from: {
      blueprint: string;
      identifier: string;
    };
    relation: string;
    to: {
      blueprint: string;
      identifier: string;
    };
  }>;
  truncated: boolean;
};

export type RelatedEntities = {
  outgoing: {
    [key: string]: Array<{
      blueprint: string;
      identifier: string;
      title: string;
      team: string | null;
      properties: {
        [key: string]: unknown;
      };
      relations: {
        [key: string]: unknown;
      };
      source: string;
      createdAt: string;
      updatedAt: string;
    }>;
  };
  incoming: {
    [key: string]: Array<{
      blueprint: string;
      identifier: string;
      title: string;
      team: string | null;
      properties: {
        [key: string]: unknown;
      };
      relations: {
        [key: string]: unknown;
      };
      source: string;
      createdAt: string;
      updatedAt: string;
    }>;
  };
  incomingTitles?: {
    [key: string]: string;
  };
};

export type Insights = {
  days: number;
  since: string;
  until: string;
  deploymentFrequency: {
    value: number | null;
    unit: "per_day";
    count: number;
    band: "elite" | "high" | "medium" | "low" | null;
  };
  leadTime: {
    value: number | null;
    unit: "hours";
    samples: number;
    band: "elite" | "high" | "medium" | "low" | null;
  };
  changeFailureRate: {
    value: number | null;
    unit: "ratio";
    failed: number;
    total: number;
    band: "elite" | "high" | "medium" | "low" | null;
  };
  mttr: {
    value: number | null;
    unit: "hours";
    incidents: number;
    band: "elite" | "high" | "medium" | "low" | null;
  };
};

export type SyncRun = {
  id: string;
  integration: string;
  trigger: "schedule" | "manual" | "webhook" | "startup";
  status: "running" | "success" | "partial" | "failure";
  stats: {
    upserted: number;
    deleted: number;
    skipped: number;
    failed: number;
  };
  logs: Array<string>;
  errors: Array<{
    mapping: string;
    key: string;
    message: string;
  }>;
  startedAt: string;
  endedAt: string | null;
};

export type IntegrationView = {
  identifier: string;
  title: string;
  type: string;
  enabled: boolean;
  config: {
    [key: string]: unknown;
  };
  mappings: Array<{
    kind: string;
    filter?: string;
    items?: string;
    delete?: string;
    merge: boolean;
    prune?: {
      relation: string;
      value: string;
    };
    entity: {
      blueprint: string;
      identifier: string;
      title?: string;
      team?: string;
      properties: {
        [key: string]: string;
      };
      relations: {
        [key: string]: string;
      };
    };
  }>;
  intervalMinutes: number;
  deleteMissing: boolean;
  priority: number;
  primaryFor: Array<string>;
  schedule?: string;
  deleteMaxPercent: number;
  deleteDryRun: boolean;
  managed: boolean;
  lastSync: {
    id: string;
    integration: string;
    trigger: "schedule" | "manual" | "webhook" | "startup";
    status: "running" | "success" | "partial" | "failure";
    stats: {
      upserted: number;
      deleted: number;
      skipped: number;
      failed: number;
    };
    logs: Array<string>;
    errors: Array<{
      mapping: string;
      key: string;
      message: string;
    }>;
    startedAt: string;
    endedAt: string | null;
  } | null;
  lastSuccessAt: string | null;
  webhookUrl?: string;
};

export type PolicyView = {
  identifier: string;
  title: string;
  description: string;
  enabled: boolean;
  target: "run" | "entity";
  match: {
    actions?: Array<string>;
    blueprints?: Array<string>;
    operations?: Array<"create" | "update" | "delete">;
  };
  expression: string;
  message: string;
  managed: boolean;
};

export type FragmentView = {
  identifier: string;
  title: string;
  description: string;
  params: {
    properties: {
      [key: string]: FragmentView_schema0;
    };
    required?: Array<string>;
    order?: Array<string>;
  };
  steps: Array<{
    id: string;
    name?: string;
    if?: string;
    needs?: Array<string>;
    retries: number;
    retryDelaySeconds: number;
    timeoutMinutes?: number;
    continueOnError: boolean;
    outputSchema?: {
      properties: {
        [key: string]: FragmentView_schema0;
      };
      required?: Array<string>;
      order?: Array<string>;
    };
    slaMinutes?: number;
    when?: "success" | "failure" | "always";
    onTimeout?: "fail" | "skip" | "continue";
    case?: string | Array<string>;
    type: "invoke";
    invoker: {
      type: string;
      [key: string]: unknown;
    };
    forEach?: {
      items: string;
      maxConcurrency: number;
      failFast: boolean;
    };
  } | {
    id: string;
    name?: string;
    if?: string;
    needs?: Array<string>;
    retries: number;
    retryDelaySeconds: number;
    timeoutMinutes?: number;
    continueOnError: boolean;
    outputSchema?: {
      properties: {
        [key: string]: FragmentView_schema0;
      };
      required?: Array<string>;
      order?: Array<string>;
    };
    slaMinutes?: number;
    when?: "success" | "failure" | "always";
    onTimeout?: "fail" | "skip" | "continue";
    case?: string | Array<string>;
    type: "approval";
    approvers?: {
      roles?: Array<string>;
      teams?: Array<string>;
      users?: Array<string>;
      ownerTeam?: boolean;
    };
    choices?: Array<string>;
    fields?: {
      properties: {
        [key: string]: FragmentView_schema0;
      };
      required?: Array<string>;
      order?: Array<string>;
    };
    minApprovals: number;
    allowSelfApproval: boolean;
    message?: string;
    tiers?: Array<{
      name: string;
      approvers?: {
        roles?: Array<string>;
        teams?: Array<string>;
        users?: Array<string>;
        ownerTeam?: boolean;
      };
      minApprovals: number;
    }>;
    remindEvery?: string;
    maxReminders?: number;
    escalate?: {
      after: string;
      approvers: {
        roles?: Array<string>;
        teams?: Array<string>;
        users?: Array<string>;
        ownerTeam?: boolean;
      };
    };
    onExpiry?: "fail" | "reject" | "approve" | "skip";
  } | {
    id: string;
    name?: string;
    if?: string;
    needs?: Array<string>;
    retries: number;
    retryDelaySeconds: number;
    timeoutMinutes?: number;
    continueOnError: boolean;
    outputSchema?: {
      properties: {
        [key: string]: FragmentView_schema0;
      };
      required?: Array<string>;
      order?: Array<string>;
    };
    slaMinutes?: number;
    when?: "success" | "failure" | "always";
    onTimeout?: "fail" | "skip" | "continue";
    case?: string | Array<string>;
    type: "agent";
    model: string;
    effort: "low" | "medium" | "high" | "xhigh" | "max";
    system?: string;
    prompt: string;
    output?: {
      properties: {
        [key: string]: {
          [key: string]: unknown;
        };
      };
      required?: Array<string>;
      order?: Array<string>;
    };
    tools: Array<"catalog" | "upsert_entity" | "trigger_action" | "http">;
    guardrails: {
      entityBlueprints: Array<string>;
      actions: Array<string>;
      httpHosts: Array<string>;
      httpMethods: Array<"GET" | "POST" | "PUT" | "PATCH" | "DELETE">;
      maxWrites: number;
    };
    mcpServers: Array<{
      name: string;
      url: string;
      token?: string;
      allowedTools?: Array<string>;
    }>;
    maxTurns: number;
    maxTokens: number;
    maxCostUsd?: number;
    provider?: "anthropic" | "bedrock" | "vertex";
    apiKey?: string;
    forEach?: {
      items: string;
      maxConcurrency: number;
      failFast: boolean;
    };
  } | {
    id: string;
    name?: string;
    if?: string;
    needs?: Array<string>;
    retries: number;
    retryDelaySeconds: number;
    timeoutMinutes?: number;
    continueOnError: boolean;
    outputSchema?: {
      properties: {
        [key: string]: FragmentView_schema0;
      };
      required?: Array<string>;
      order?: Array<string>;
    };
    slaMinutes?: number;
    when?: "success" | "failure" | "always";
    onTimeout?: "fail" | "skip" | "continue";
    case?: string | Array<string>;
    type: "wait";
    duration?: string;
    until?: string;
    event?: {
      name: string;
      filter?: string;
    };
  } | {
    id: string;
    name?: string;
    if?: string;
    needs?: Array<string>;
    retries: number;
    retryDelaySeconds: number;
    timeoutMinutes?: number;
    continueOnError: boolean;
    outputSchema?: {
      properties: {
        [key: string]: FragmentView_schema0;
      };
      required?: Array<string>;
      order?: Array<string>;
    };
    slaMinutes?: number;
    when?: "success" | "failure" | "always";
    onTimeout?: "fail" | "skip" | "continue";
    case?: string | Array<string>;
    type: "input";
    message?: string;
    inputs: {
      properties: {
        [key: string]: FragmentView_schema0;
      };
      required?: Array<string>;
      order?: Array<string>;
    };
    assignees?: {
      roles?: Array<string>;
      teams?: Array<string>;
      users?: Array<string>;
      ownerTeam?: boolean;
    };
    remindEvery?: string;
    maxReminders?: number;
  } | {
    id: string;
    name?: string;
    if?: string;
    needs?: Array<string>;
    retries: number;
    retryDelaySeconds: number;
    timeoutMinutes?: number;
    continueOnError: boolean;
    outputSchema?: {
      properties: {
        [key: string]: FragmentView_schema0;
      };
      required?: Array<string>;
      order?: Array<string>;
    };
    slaMinutes?: number;
    when?: "success" | "failure" | "always";
    onTimeout?: "fail" | "skip" | "continue";
    case?: string | Array<string>;
    type: "workflow";
    action: string;
    inputs: {
      [key: string]: unknown;
    };
    entity?: string;
    forEach?: {
      items: string;
      maxConcurrency: number;
      failFast: boolean;
    };
  } | {
    id: string;
    name?: string;
    if?: string;
    needs?: Array<string>;
    retries: number;
    retryDelaySeconds: number;
    timeoutMinutes?: number;
    continueOnError: boolean;
    outputSchema?: {
      properties: {
        [key: string]: FragmentView_schema0;
      };
      required?: Array<string>;
      order?: Array<string>;
    };
    slaMinutes?: number;
    when?: "success" | "failure" | "always";
    onTimeout?: "fail" | "skip" | "continue";
    case?: string | Array<string>;
    type: "transform";
    output: {
      [key: string]: string;
    };
    forEach?: {
      items: string;
      maxConcurrency: number;
      failFast: boolean;
    };
  } | {
    id: string;
    name?: string;
    if?: string;
    needs?: Array<string>;
    retries: number;
    retryDelaySeconds: number;
    timeoutMinutes?: number;
    continueOnError: boolean;
    outputSchema?: {
      properties: {
        [key: string]: FragmentView_schema0;
      };
      required?: Array<string>;
      order?: Array<string>;
    };
    slaMinutes?: number;
    when?: "success" | "failure" | "always";
    onTimeout?: "fail" | "skip" | "continue";
    case?: string | Array<string>;
    type: "switch";
    cases: Array<{
      id: string;
      when: string;
    }>;
    default?: string;
  } | {
    id: string;
    name?: string;
    if?: string;
    needs?: Array<string>;
    retries: number;
    retryDelaySeconds: number;
    timeoutMinutes?: number;
    continueOnError: boolean;
    outputSchema?: {
      properties: {
        [key: string]: FragmentView_schema0;
      };
      required?: Array<string>;
      order?: Array<string>;
    };
    slaMinutes?: number;
    when?: "success" | "failure" | "always";
    onTimeout?: "fail" | "skip" | "continue";
    case?: string | Array<string>;
    type: "fragment";
    fragment: string;
    with: {
      [key: string]: unknown;
    };
  }>;
  outputs: {
    [key: string]: string;
  };
  version: number;
  managed: boolean;
  updatedAt: string;
};

export type WebhookView = {
  identifier: string;
  title: string;
  url: string;
  events: Array<string>;
  blueprints: Array<string>;
  secret?: string | null;
  secondarySecret?: string | null;
  headers: {
    [key: string]: string;
  };
  filter?: string | null;
  transform?: string | null;
  enabled: boolean;
  managed: boolean;
  hasSecret: boolean;
};

export type Delivery = {
  id: string;
  webhook: string;
  event: string;
  status: "pending" | "success" | "failed";
  attempts: number;
  responseStatus: number | null;
  lastError: string | null;
  createdAt: string;
  deliveredAt: string | null;
};

export type Run = {
  id: string;
  action: string;
  actionTitle: string;
  status: string;
  inputs: {
    [key: string]: unknown;
  };
  createdAt: string;
  endedAt: string | null;
  [key: string]: unknown;
};

export type ConfigStatus = {
  appliedHash: string | null;
  appliedAt: string | null;
  errors: Array<string>;
  readError: string | null;
  inSync: boolean;
  [key: string]: unknown;
};

export type EntityPage = {
  items: Array<unknown>;
  total: number;
};

export type RunPage = {
  items: Array<unknown>;
  total: number;
};

export type Blueprint_schema0 = {
  type: "string" | "number" | "integer" | "boolean" | "array" | "object";
  title?: string;
  description?: string;
  format?: string;
  blueprint?: string;
  enum?: Array<string | number>;
  items?: Blueprint_schema0;
  [key: string]: unknown;
};

export type Action_schema0 = {
  type: "string" | "number" | "integer" | "boolean" | "array" | "object";
  title?: string;
  description?: string;
  format?: string;
  blueprint?: string;
  enum?: Array<string | number>;
  items?: Action_schema0;
  [key: string]: unknown;
};

export type Fragment_schema0 = {
  type: "string" | "number" | "integer" | "boolean" | "array" | "object";
  title?: string;
  description?: string;
  format?: string;
  blueprint?: string;
  enum?: Array<string | number>;
  items?: Fragment_schema0;
  [key: string]: unknown;
};

export type ConfigFile_schema0 = {
  type: "string" | "number" | "integer" | "boolean" | "array" | "object";
  title?: string;
  description?: string;
  format?: string;
  blueprint?: string;
  enum?: Array<string | number>;
  items?: ConfigFile_schema0;
  [key: string]: unknown;
};

export type FragmentView_schema0 = {
  type: "string" | "number" | "integer" | "boolean" | "array" | "object";
  title?: string;
  description?: string;
  format?: string;
  blueprint?: string;
  enum?: Array<string | number>;
  items?: FragmentView_schema0;
  [key: string]: unknown;
};

export type Error = {
  error: string;
};

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
  }
}

export interface ClientOptions {
  /** Base URL of the platform, e.g. https://portal.example.com */
  baseUrl: string;
  /** Personal API token (Admin → Tokens) */
  token: string;
  fetch?: typeof fetch;
}

export class AsteriusClient {
  constructor(private options: ClientOptions) {}

  private async request<T>(method: string, path: string, opts: { query?: Record<string, string | number | undefined>; body?: unknown } = {}): Promise<T> {
    const url = new URL(path, this.options.baseUrl);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const res = await (this.options.fetch ?? fetch)(url, {
      method,
      headers: { authorization: `Bearer ${this.options.token}`, accept: 'application/json', ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : undefined;
    if (!res.ok) throw new ApiError(res.status, (data as { error?: string } | undefined)?.error ?? res.statusText, data);
    return data as T;
  }

  /** GET /api/descriptor-schema.json */
  getDescriptorSchemaJson(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/descriptor-schema.json`, { query });
  }

  /** DELETE /api/mcp */
  deleteMcp(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('DELETE', `/api/mcp`, { query });
  }

  /** GET /api/mcp */
  getMcp(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/mcp`, { query });
  }

  /** POST /api/mcp */
  postMcp(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/mcp`, { query });
  }

  /** GET /api/meta */
  getMeta(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/meta`, { query });
  }

  /** GET /api/orgs */
  getOrgs(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/orgs`, { query });
  }

  /** POST /api/orgs */
  postOrgs(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/orgs`, { query });
  }

  /** DELETE /api/orgs/{id} */
  deleteOrgsById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('DELETE', `/api/orgs/${encodeURIComponent(id)}`, { query });
  }

  /** GET /api/v1/actions */
  getActions(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/actions`, { query });
  }

  /** DELETE /api/v1/actions/{id} */
  deleteActionsById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('DELETE', `/api/v1/actions/${encodeURIComponent(id)}`, { query });
  }

  /** GET /api/v1/actions/{id} */
  getActionsById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/actions/${encodeURIComponent(id)}`, { query });
  }

  /** PUT /api/v1/actions/{id} */
  putActionsById(id: string, body: Action, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('PUT', `/api/v1/actions/${encodeURIComponent(id)}`, { query, body });
  }

  /** GET /api/v1/actions/{id}/diff */
  getActionsDiffById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/actions/${encodeURIComponent(id)}/diff`, { query });
  }

  /** POST /api/v1/actions/{id}/dry-run */
  postActionsDryRunById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/actions/${encodeURIComponent(id)}/dry-run`, { query });
  }

  /** POST /api/v1/actions/{id}/rollback */
  postActionsRollbackById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/actions/${encodeURIComponent(id)}/rollback`, { query });
  }

  /** POST /api/v1/actions/{id}/runs */
  postActionsRunsById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/actions/${encodeURIComponent(id)}/runs`, { query });
  }

  /** POST /api/v1/actions/{id}/tests/run */
  postActionsTestsRunById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/actions/${encodeURIComponent(id)}/tests/run`, { query });
  }

  /** GET /api/v1/actions/{id}/versions */
  getActionsVersionsById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/actions/${encodeURIComponent(id)}/versions`, { query });
  }

  /** GET /api/v1/actions/{id}/versions/{version} */
  getActionsVersionsByIdVersion(id: string, version: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/actions/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}`, { query });
  }

  /** POST /api/v1/actions/dry-run */
  postActionsDryRun(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/actions/dry-run`, { query });
  }

  /** POST /api/v1/ai/ask */
  postAiAsk(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/ai/ask`, { query });
  }

  /** GET /api/v1/ai/budgets */
  getAiBudgets(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/ai/budgets`, { query });
  }

  /** PUT /api/v1/ai/budgets */
  putAiBudgets(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('PUT', `/api/v1/ai/budgets`, { query });
  }

  /** DELETE /api/v1/ai/budgets/{id} */
  deleteAiBudgetsById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('DELETE', `/api/v1/ai/budgets/${encodeURIComponent(id)}`, { query });
  }

  /** POST /api/v1/ai/draft-blueprint */
  postAiDraftBlueprint(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/ai/draft-blueprint`, { query });
  }

  /** POST /api/v1/ai/draft-workflow */
  postAiDraftWorkflow(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/ai/draft-workflow`, { query });
  }

  /** GET /api/v1/ai/prices */
  getAiPrices(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/ai/prices`, { query });
  }

  /** DELETE /api/v1/ai/prices/{model} */
  deleteAiPricesByModel(model: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('DELETE', `/api/v1/ai/prices/${encodeURIComponent(model)}`, { query });
  }

  /** PUT /api/v1/ai/prices/{model} */
  putAiPricesByModel(model: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('PUT', `/api/v1/ai/prices/${encodeURIComponent(model)}`, { query });
  }

  /** GET /api/v1/ai/reviews */
  getAiReviews(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/ai/reviews`, { query });
  }

  /** GET /api/v1/ai/reviews/{id} */
  getAiReviewsById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/ai/reviews/${encodeURIComponent(id)}`, { query });
  }

  /** POST /api/v1/ai/reviews/run */
  postAiReviewsRun(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/ai/reviews/run`, { query });
  }

  /** POST /api/v1/ai/runs/{id}/explain */
  postAiRunsExplainById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/ai/runs/${encodeURIComponent(id)}/explain`, { query });
  }

  /** GET /api/v1/ai/status */
  getAiStatus(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/ai/status`, { query });
  }

  /** POST /api/v1/ai/suggest-mapping */
  postAiSuggestMapping(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/ai/suggest-mapping`, { query });
  }

  /** GET /api/v1/ai/usage */
  getAiUsage(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/ai/usage`, { query });
  }

  /** GET /api/v1/approvals */
  getApprovals(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/approvals`, { query });
  }

  /** GET /api/v1/archive */
  getArchive(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/archive`, { query });
  }

  /** POST /api/v1/archive/import */
  postArchiveImport(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/archive/import`, { query });
  }

  /** GET /api/v1/audit */
  getAudit(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/audit`, { query });
  }

  /** GET /api/v1/audit/export */
  getAuditExport(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/audit/export`, { query });
  }

  /** GET /api/v1/audit/facets */
  getAuditFacets(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/audit/facets`, { query });
  }

  /** GET /api/v1/audit/verify */
  getAuditVerify(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/audit/verify`, { query });
  }

  /** GET /api/v1/blueprints */
  getBlueprints(query?: Record<string, string | number | undefined>): Promise<Array<Blueprint>> {
    return this.request('GET', `/api/v1/blueprints`, { query });
  }

  /** DELETE /api/v1/blueprints/{bp} */
  deleteBlueprintsByBp(bp: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('DELETE', `/api/v1/blueprints/${encodeURIComponent(bp)}`, { query });
  }

  /** GET /api/v1/blueprints/{bp} */
  getBlueprintsByBp(bp: string, query?: Record<string, string | number | undefined>): Promise<Blueprint> {
    return this.request('GET', `/api/v1/blueprints/${encodeURIComponent(bp)}`, { query });
  }

  /** PUT /api/v1/blueprints/{bp} */
  putBlueprintsByBp(bp: string, body: Blueprint, query?: Record<string, string | number | undefined>): Promise<Blueprint> {
    return this.request('PUT', `/api/v1/blueprints/${encodeURIComponent(bp)}`, { query, body });
  }

  /** GET /api/v1/blueprints/{bp}/entities */
  getBlueprintsEntitiesByBp(bp: string, query?: Record<string, string | number | undefined>): Promise<EntityPage> {
    return this.request('GET', `/api/v1/blueprints/${encodeURIComponent(bp)}/entities`, { query });
  }

  /** POST /api/v1/blueprints/{bp}/entities */
  postBlueprintsEntitiesByBp(bp: string, body: EntityInput, query?: Record<string, string | number | undefined>): Promise<Entity> {
    return this.request('POST', `/api/v1/blueprints/${encodeURIComponent(bp)}/entities`, { query, body });
  }

  /** DELETE /api/v1/blueprints/{bp}/entities/{id} */
  deleteBlueprintsEntitiesByBpId(bp: string, id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('DELETE', `/api/v1/blueprints/${encodeURIComponent(bp)}/entities/${encodeURIComponent(id)}`, { query });
  }

  /** GET /api/v1/blueprints/{bp}/entities/{id} */
  getBlueprintsEntitiesByBpId(bp: string, id: string, query?: Record<string, string | number | undefined>): Promise<Entity> {
    return this.request('GET', `/api/v1/blueprints/${encodeURIComponent(bp)}/entities/${encodeURIComponent(id)}`, { query });
  }

  /** PATCH /api/v1/blueprints/{bp}/entities/{id} */
  patchBlueprintsEntitiesByBpId(bp: string, id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('PATCH', `/api/v1/blueprints/${encodeURIComponent(bp)}/entities/${encodeURIComponent(id)}`, { query });
  }

  /** PUT /api/v1/blueprints/{bp}/entities/{id} */
  putBlueprintsEntitiesByBpId(bp: string, id: string, body: EntityInput, query?: Record<string, string | number | undefined>): Promise<Entity> {
    return this.request('PUT', `/api/v1/blueprints/${encodeURIComponent(bp)}/entities/${encodeURIComponent(id)}`, { query, body });
  }

  /** GET /api/v1/blueprints/{bp}/entities/{id}/actions */
  getBlueprintsEntitiesActionsByBpId(bp: string, id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/blueprints/${encodeURIComponent(bp)}/entities/${encodeURIComponent(id)}/actions`, { query });
  }

  /** GET /api/v1/blueprints/{bp}/entities/{id}/docs */
  getBlueprintsEntitiesDocsByBpId(bp: string, id: string, query?: Record<string, string | number | undefined>): Promise<EntityDocs> {
    return this.request('GET', `/api/v1/blueprints/${encodeURIComponent(bp)}/entities/${encodeURIComponent(id)}/docs`, { query });
  }

  /** GET /api/v1/blueprints/{bp}/entities/{id}/graph */
  getBlueprintsEntitiesGraphByBpId(bp: string, id: string, query?: Record<string, string | number | undefined>): Promise<EntityGraph> {
    return this.request('GET', `/api/v1/blueprints/${encodeURIComponent(bp)}/entities/${encodeURIComponent(id)}/graph`, { query });
  }

  /** GET /api/v1/blueprints/{bp}/entities/{id}/history */
  getBlueprintsEntitiesHistoryByBpId(bp: string, id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/blueprints/${encodeURIComponent(bp)}/entities/${encodeURIComponent(id)}/history`, { query });
  }

  /** POST /api/v1/blueprints/{bp}/entities/{id}/history/{version}/revert */
  postBlueprintsEntitiesHistoryRevertByBpIdVersion(bp: string, id: string, version: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/blueprints/${encodeURIComponent(bp)}/entities/${encodeURIComponent(id)}/history/${encodeURIComponent(version)}/revert`, { query });
  }

  /** GET /api/v1/blueprints/{bp}/entities/{id}/related */
  getBlueprintsEntitiesRelatedByBpId(bp: string, id: string, query?: Record<string, string | number | undefined>): Promise<RelatedEntities> {
    return this.request('GET', `/api/v1/blueprints/${encodeURIComponent(bp)}/entities/${encodeURIComponent(id)}/related`, { query });
  }

  /** POST /api/v1/blueprints/{bp}/entities/{id}/restore */
  postBlueprintsEntitiesRestoreByBpId(bp: string, id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/blueprints/${encodeURIComponent(bp)}/entities/${encodeURIComponent(id)}/restore`, { query });
  }

  /** GET /api/v1/blueprints/{bp}/entities/{id}/scorecards */
  getBlueprintsEntitiesScorecardsByBpId(bp: string, id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/blueprints/${encodeURIComponent(bp)}/entities/${encodeURIComponent(id)}/scorecards`, { query });
  }

  /** POST /api/v1/blueprints/{bp}/entities/bulk */
  postBlueprintsEntitiesBulkByBp(bp: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/blueprints/${encodeURIComponent(bp)}/entities/bulk`, { query });
  }

  /** POST /api/v1/blueprints/{bp}/entities/query */
  postBlueprintsEntitiesQueryByBp(bp: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/blueprints/${encodeURIComponent(bp)}/entities/query`, { query });
  }

  /** POST /api/v1/blueprints/{bp}/impact */
  postBlueprintsImpactByBp(bp: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/blueprints/${encodeURIComponent(bp)}/impact`, { query });
  }

  /** POST /api/v1/blueprints/{bp}/migrate */
  postBlueprintsMigrateByBp(bp: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/blueprints/${encodeURIComponent(bp)}/migrate`, { query });
  }

  /** POST /api/v1/blueprints/{bp}/repair-relations */
  postBlueprintsRepairRelationsByBp(bp: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/blueprints/${encodeURIComponent(bp)}/repair-relations`, { query });
  }

  /** GET /api/v1/blueprints/{bp}/scorecard-levels */
  getBlueprintsScorecardLevelsByBp(bp: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/blueprints/${encodeURIComponent(bp)}/scorecard-levels`, { query });
  }

  /** GET /api/v1/blueprints/{bp}/validation */
  getBlueprintsValidationByBp(bp: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/blueprints/${encodeURIComponent(bp)}/validation`, { query });
  }

  /** GET /api/v1/config */
  getConfig(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/config`, { query });
  }

  /** GET /api/v1/config/diff */
  getConfigDiff(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/config/diff`, { query });
  }

  /** GET /api/v1/config/export */
  getConfigExport(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/config/export`, { query });
  }

  /** POST /api/v1/config/import */
  postConfigImport(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/config/import`, { query });
  }

  /** GET /api/v1/config/plan */
  getConfigPlan(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/config/plan`, { query });
  }

  /** POST /api/v1/config/reload */
  postConfigReload(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/config/reload`, { query });
  }

  /** GET /api/v1/config/status */
  getConfigStatus(query?: Record<string, string | number | undefined>): Promise<ConfigStatus> {
    return this.request('GET', `/api/v1/config/status`, { query });
  }

  /** GET /api/v1/dashboards */
  getDashboards(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/dashboards`, { query });
  }

  /** DELETE /api/v1/dashboards/{id} */
  deleteDashboardsById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('DELETE', `/api/v1/dashboards/${encodeURIComponent(id)}`, { query });
  }

  /** GET /api/v1/dashboards/{id} */
  getDashboardsById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/dashboards/${encodeURIComponent(id)}`, { query });
  }

  /** PUT /api/v1/dashboards/{id} */
  putDashboardsById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('PUT', `/api/v1/dashboards/${encodeURIComponent(id)}`, { query });
  }

  /** GET /api/v1/dashboards/{id}/data */
  getDashboardsDataById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/dashboards/${encodeURIComponent(id)}/data`, { query });
  }

  /** GET /api/v1/dashboards/resolve */
  getDashboardsResolve(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/dashboards/resolve`, { query });
  }

  /** GET /api/v1/delegations */
  getDelegations(query?: Record<string, string | number | undefined>): Promise<Array<Delegation>> {
    return this.request('GET', `/api/v1/delegations`, { query });
  }

  /** DELETE /api/v1/delegations/{userId} */
  deleteDelegationsByUserId(userId: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('DELETE', `/api/v1/delegations/${encodeURIComponent(userId)}`, { query });
  }

  /** GET /api/v1/deleted-entities */
  getDeletedEntities(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/deleted-entities`, { query });
  }

  /** DELETE /api/v1/deleted-entities/{bp}/{id} */
  deleteDeletedEntitiesByBpId(bp: string, id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('DELETE', `/api/v1/deleted-entities/${encodeURIComponent(bp)}/${encodeURIComponent(id)}`, { query });
  }

  /** GET /api/v1/deliveries */
  getDeliveries(query?: Record<string, string | number | undefined>): Promise<Array<Delivery>> {
    return this.request('GET', `/api/v1/deliveries`, { query });
  }

  /** POST /api/v1/deliveries/{id}/redeliver */
  postDeliveriesRedeliverById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/deliveries/${encodeURIComponent(id)}/redeliver`, { query });
  }

  /** POST /api/v1/deliveries/redeliver */
  postDeliveriesRedeliver(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/deliveries/redeliver`, { query });
  }

  /** POST /api/v1/deliveries/redeliver-failed */
  postDeliveriesRedeliverFailed(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/deliveries/redeliver-failed`, { query });
  }

  /** GET /api/v1/entities */
  getEntities(query?: Record<string, string | number | undefined>): Promise<EntityPage> {
    return this.request('GET', `/api/v1/entities`, { query });
  }

  /** GET /api/v1/entities/{bp}/{id}/graph */
  getEntitiesGraphByBpId(bp: string, id: string, query?: Record<string, string | number | undefined>): Promise<EntityGraph> {
    return this.request('GET', `/api/v1/entities/${encodeURIComponent(bp)}/${encodeURIComponent(id)}/graph`, { query });
  }

  /** GET /api/v1/entities/{bp}/{id}/history */
  getEntitiesHistoryByBpId(bp: string, id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/entities/${encodeURIComponent(bp)}/${encodeURIComponent(id)}/history`, { query });
  }

  /** POST /api/v1/entities/query */
  postEntitiesQuery(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/entities/query`, { query });
  }

  /** POST /api/v1/expressions/check */
  postExpressionsCheck(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/expressions/check`, { query });
  }

  /** GET /api/v1/fragments */
  getFragments(query?: Record<string, string | number | undefined>): Promise<Array<FragmentView>> {
    return this.request('GET', `/api/v1/fragments`, { query });
  }

  /** DELETE /api/v1/fragments/{id} */
  deleteFragmentsById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('DELETE', `/api/v1/fragments/${encodeURIComponent(id)}`, { query });
  }

  /** GET /api/v1/fragments/{id} */
  getFragmentsById(id: string, query?: Record<string, string | number | undefined>): Promise<FragmentView> {
    return this.request('GET', `/api/v1/fragments/${encodeURIComponent(id)}`, { query });
  }

  /** PUT /api/v1/fragments/{id} */
  putFragmentsById(id: string, body: Fragment, query?: Record<string, string | number | undefined>): Promise<FragmentView> {
    return this.request('PUT', `/api/v1/fragments/${encodeURIComponent(id)}`, { query, body });
  }

  /** GET /api/v1/fragments/{id}/usage */
  getFragmentsUsageById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/fragments/${encodeURIComponent(id)}/usage`, { query });
  }

  /** GET /api/v1/fragments/{id}/versions */
  getFragmentsVersionsById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/fragments/${encodeURIComponent(id)}/versions`, { query });
  }

  /** GET /api/v1/home */
  getHome(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/home`, { query });
  }

  /** POST /api/v1/hooks/{id} */
  postHooksById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/hooks/${encodeURIComponent(id)}`, { query });
  }

  /** POST /api/v1/hooks/{org}/{id} */
  postHooksByOrgId(org: string, id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/hooks/${encodeURIComponent(org)}/${encodeURIComponent(id)}`, { query });
  }

  /** GET /api/v1/insights */
  getInsights(query?: Record<string, string | number | undefined>): Promise<Insights> {
    return this.request('GET', `/api/v1/insights`, { query });
  }

  /** GET /api/v1/integrations */
  getIntegrations(query?: Record<string, string | number | undefined>): Promise<Array<IntegrationView>> {
    return this.request('GET', `/api/v1/integrations`, { query });
  }

  /** DELETE /api/v1/integrations/{id} */
  deleteIntegrationsById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('DELETE', `/api/v1/integrations/${encodeURIComponent(id)}`, { query });
  }

  /** GET /api/v1/integrations/{id} */
  getIntegrationsById(id: string, query?: Record<string, string | number | undefined>): Promise<IntegrationView> {
    return this.request('GET', `/api/v1/integrations/${encodeURIComponent(id)}`, { query });
  }

  /** PUT /api/v1/integrations/{id} */
  putIntegrationsById(id: string, body: Integration, query?: Record<string, string | number | undefined>): Promise<IntegrationView> {
    return this.request('PUT', `/api/v1/integrations/${encodeURIComponent(id)}`, { query, body });
  }

  /** POST /api/v1/integrations/{id}/sync */
  postIntegrationsSyncById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/integrations/${encodeURIComponent(id)}/sync`, { query });
  }

  /** GET /api/v1/integrations/{id}/syncs */
  getIntegrationsSyncsById(id: string, query?: Record<string, string | number | undefined>): Promise<Array<SyncRun>> {
    return this.request('GET', `/api/v1/integrations/${encodeURIComponent(id)}/syncs`, { query });
  }

  /** POST /api/v1/integrations/{id}/test */
  postIntegrationsTestById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/integrations/${encodeURIComponent(id)}/test`, { query });
  }

  /** POST /api/v1/integrations/test */
  postIntegrationsTest(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/integrations/test`, { query });
  }

  /** POST /api/v1/mappings/preview */
  postMappingsPreview(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/mappings/preview`, { query });
  }

  /** DELETE /api/v1/mcp */
  deleteApiV1Mcp(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('DELETE', `/api/v1/mcp`, { query });
  }

  /** GET /api/v1/mcp */
  getApiV1Mcp(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/mcp`, { query });
  }

  /** POST /api/v1/mcp */
  postApiV1Mcp(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/mcp`, { query });
  }

  /** DELETE /api/v1/me/delegation */
  deleteMeDelegation(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('DELETE', `/api/v1/me/delegation`, { query });
  }

  /** GET /api/v1/me/delegation */
  getMeDelegation(query?: Record<string, string | number | undefined>): Promise<MyDelegation> {
    return this.request('GET', `/api/v1/me/delegation`, { query });
  }

  /** PUT /api/v1/me/delegation */
  putMeDelegation(body: DelegationInput, query?: Record<string, string | number | undefined>): Promise<MyDelegation> {
    return this.request('PUT', `/api/v1/me/delegation`, { query, body });
  }

  /** GET /api/v1/me/notifications */
  getMeNotifications(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/me/notifications`, { query });
  }

  /** PUT /api/v1/me/notifications */
  putMeNotifications(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('PUT', `/api/v1/me/notifications`, { query });
  }

  /** GET /api/v1/notification-settings */
  getNotificationSettings(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/notification-settings`, { query });
  }

  /** PUT /api/v1/notification-settings */
  putNotificationSettings(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('PUT', `/api/v1/notification-settings`, { query });
  }

  /** POST /api/v1/notification-settings/test */
  postNotificationSettingsTest(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/notification-settings/test`, { query });
  }

  /** GET /api/v1/notifications */
  getNotifications(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/notifications`, { query });
  }

  /** GET /api/v1/notifications/channels */
  getNotificationsChannels(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/notifications/channels`, { query });
  }

  /** GET /api/v1/notifications/preferences */
  getNotificationsPreferences(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/notifications/preferences`, { query });
  }

  /** PUT /api/v1/notifications/preferences */
  putNotificationsPreferences(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('PUT', `/api/v1/notifications/preferences`, { query });
  }

  /** POST /api/v1/notifications/read */
  postNotificationsRead(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/notifications/read`, { query });
  }

  /** DELETE /api/v1/org */
  deleteOrg(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('DELETE', `/api/v1/org`, { query });
  }

  /** GET /api/v1/org */
  getOrg(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/org`, { query });
  }

  /** PATCH /api/v1/org */
  patchOrg(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('PATCH', `/api/v1/org`, { query });
  }

  /** PUT /api/v1/org/config-source */
  putOrgConfigSource(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('PUT', `/api/v1/org/config-source`, { query });
  }

  /** POST /api/v1/org/config/sync */
  postOrgConfigSync(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/org/config/sync`, { query });
  }

  /** POST /api/v1/org/domains/verify */
  postOrgDomainsVerify(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/org/domains/verify`, { query });
  }

  /** GET /api/v1/org/members */
  getOrgMembers(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/org/members`, { query });
  }

  /** POST /api/v1/org/members */
  postOrgMembers(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/org/members`, { query });
  }

  /** DELETE /api/v1/org/members/{id} */
  deleteOrgMembersById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('DELETE', `/api/v1/org/members/${encodeURIComponent(id)}`, { query });
  }

  /** PATCH /api/v1/org/members/{id} */
  patchOrgMembersById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('PATCH', `/api/v1/org/members/${encodeURIComponent(id)}`, { query });
  }

  /** GET /api/v1/org/sso */
  getOrgSso(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/org/sso`, { query });
  }

  /** POST /api/v1/org/sso/enable */
  postOrgSsoEnable(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/org/sso/enable`, { query });
  }

  /** POST /api/v1/org/sso/providers */
  postOrgSsoProviders(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/org/sso/providers`, { query });
  }

  /** DELETE /api/v1/org/sso/providers/{alias} */
  deleteOrgSsoProvidersByAlias(alias: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('DELETE', `/api/v1/org/sso/providers/${encodeURIComponent(alias)}`, { query });
  }

  /** GET /api/v1/permissions */
  getPermissions(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/permissions`, { query });
  }

  /** GET /api/v1/policies */
  getPolicies(query?: Record<string, string | number | undefined>): Promise<Array<PolicyView>> {
    return this.request('GET', `/api/v1/policies`, { query });
  }

  /** DELETE /api/v1/policies/{id} */
  deletePoliciesById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('DELETE', `/api/v1/policies/${encodeURIComponent(id)}`, { query });
  }

  /** GET /api/v1/policies/{id} */
  getPoliciesById(id: string, query?: Record<string, string | number | undefined>): Promise<PolicyView> {
    return this.request('GET', `/api/v1/policies/${encodeURIComponent(id)}`, { query });
  }

  /** PUT /api/v1/policies/{id} */
  putPoliciesById(id: string, body: Policy, query?: Record<string, string | number | undefined>): Promise<PolicyView> {
    return this.request('PUT', `/api/v1/policies/${encodeURIComponent(id)}`, { query, body });
  }

  /** GET /api/v1/runs */
  getRuns(query?: Record<string, string | number | undefined>): Promise<RunPage> {
    return this.request('GET', `/api/v1/runs`, { query });
  }

  /** GET /api/v1/runs/{id} */
  getRunsById(id: string, query?: Record<string, string | number | undefined>): Promise<Run> {
    return this.request('GET', `/api/v1/runs/${encodeURIComponent(id)}`, { query });
  }

  /** PATCH /api/v1/runs/{id} */
  patchRunsById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('PATCH', `/api/v1/runs/${encodeURIComponent(id)}`, { query });
  }

  /** POST /api/v1/runs/{id}/approve */
  postRunsApproveById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/runs/${encodeURIComponent(id)}/approve`, { query });
  }

  /** GET /api/v1/runs/{id}/artifacts */
  getRunsArtifactsById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/runs/${encodeURIComponent(id)}/artifacts`, { query });
  }

  /** GET /api/v1/runs/{id}/artifacts/{artifactId} */
  getRunsArtifactsByIdArtifactId(id: string, artifactId: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/runs/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(artifactId)}`, { query });
  }

  /** POST /api/v1/runs/{id}/cancel */
  postRunsCancelById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/runs/${encodeURIComponent(id)}/cancel`, { query });
  }

  /** GET /api/v1/runs/{id}/events */
  getRunsEventsById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/runs/${encodeURIComponent(id)}/events`, { query });
  }

  /** GET /api/v1/runs/{id}/logs */
  getRunsLogsById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/runs/${encodeURIComponent(id)}/logs`, { query });
  }

  /** POST /api/v1/runs/{id}/logs */
  postRunsLogsById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/runs/${encodeURIComponent(id)}/logs`, { query });
  }

  /** POST /api/v1/runs/{id}/pause */
  postRunsPauseById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/runs/${encodeURIComponent(id)}/pause`, { query });
  }

  /** POST /api/v1/runs/{id}/reject */
  postRunsRejectById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/runs/${encodeURIComponent(id)}/reject`, { query });
  }

  /** POST /api/v1/runs/{id}/rerun */
  postRunsRerunById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/runs/${encodeURIComponent(id)}/rerun`, { query });
  }

  /** POST /api/v1/runs/{id}/resume */
  postRunsResumeById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/runs/${encodeURIComponent(id)}/resume`, { query });
  }

  /** PATCH /api/v1/runs/{id}/steps/{step} */
  patchRunsStepsByIdStep(id: string, step: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('PATCH', `/api/v1/runs/${encodeURIComponent(id)}/steps/${encodeURIComponent(step)}`, { query });
  }

  /** POST /api/v1/runs/{id}/steps/{step}/approve */
  postRunsStepsApproveByIdStep(id: string, step: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/runs/${encodeURIComponent(id)}/steps/${encodeURIComponent(step)}/approve`, { query });
  }

  /** POST /api/v1/runs/{id}/steps/{step}/artifacts */
  postRunsStepsArtifactsByIdStep(id: string, step: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/runs/${encodeURIComponent(id)}/steps/${encodeURIComponent(step)}/artifacts`, { query });
  }

  /** POST /api/v1/runs/{id}/steps/{step}/complete */
  postRunsStepsCompleteByIdStep(id: string, step: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/runs/${encodeURIComponent(id)}/steps/${encodeURIComponent(step)}/complete`, { query });
  }

  /** POST /api/v1/runs/{id}/steps/{step}/events */
  postRunsStepsEventsByIdStep(id: string, step: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/runs/${encodeURIComponent(id)}/steps/${encodeURIComponent(step)}/events`, { query });
  }

  /** POST /api/v1/runs/{id}/steps/{step}/input */
  postRunsStepsInputByIdStep(id: string, step: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/runs/${encodeURIComponent(id)}/steps/${encodeURIComponent(step)}/input`, { query });
  }

  /** POST /api/v1/runs/{id}/steps/{step}/logs */
  postRunsStepsLogsByIdStep(id: string, step: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/runs/${encodeURIComponent(id)}/steps/${encodeURIComponent(step)}/logs`, { query });
  }

  /** POST /api/v1/runs/{id}/steps/{step}/reject */
  postRunsStepsRejectByIdStep(id: string, step: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/runs/${encodeURIComponent(id)}/steps/${encodeURIComponent(step)}/reject`, { query });
  }

  /** POST /api/v1/runs/{id}/steps/{step}/retry */
  postRunsStepsRetryByIdStep(id: string, step: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/runs/${encodeURIComponent(id)}/steps/${encodeURIComponent(step)}/retry`, { query });
  }

  /** POST /api/v1/runs/{id}/steps/{step}/skip */
  postRunsStepsSkipByIdStep(id: string, step: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/runs/${encodeURIComponent(id)}/steps/${encodeURIComponent(step)}/skip`, { query });
  }

  /** POST /api/v1/runs/{id}/unpause */
  postRunsUnpauseById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/runs/${encodeURIComponent(id)}/unpause`, { query });
  }

  /** POST /api/v1/scim/token */
  postScimToken(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/scim/token`, { query });
  }

  /** GET /api/v1/scorecards */
  getScorecards(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/scorecards`, { query });
  }

  /** DELETE /api/v1/scorecards/{id} */
  deleteScorecardsById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('DELETE', `/api/v1/scorecards/${encodeURIComponent(id)}`, { query });
  }

  /** GET /api/v1/scorecards/{id} */
  getScorecardsById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/scorecards/${encodeURIComponent(id)}`, { query });
  }

  /** PUT /api/v1/scorecards/{id} */
  putScorecardsById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('PUT', `/api/v1/scorecards/${encodeURIComponent(id)}`, { query });
  }

  /** POST /api/v1/scorecards/{id}/evaluate */
  postScorecardsEvaluateById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/scorecards/${encodeURIComponent(id)}/evaluate`, { query });
  }

  /** GET /api/v1/scorecards/{id}/summary */
  getScorecardsSummaryById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/scorecards/${encodeURIComponent(id)}/summary`, { query });
  }

  /** GET /api/v1/secret-providers */
  getSecretProviders(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/secret-providers`, { query });
  }

  /** GET /api/v1/secrets */
  getSecrets(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/secrets`, { query });
  }

  /** DELETE /api/v1/secrets/{id} */
  deleteSecretsById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('DELETE', `/api/v1/secrets/${encodeURIComponent(id)}`, { query });
  }

  /** PUT /api/v1/secrets/{id} */
  putSecretsById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('PUT', `/api/v1/secrets/${encodeURIComponent(id)}`, { query });
  }

  /** POST /api/v1/secrets/reencrypt */
  postSecretsReencrypt(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/secrets/reencrypt`, { query });
  }

  /** POST /api/v1/service-accounts */
  postServiceAccounts(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/service-accounts`, { query });
  }

  /** GET /api/v1/teams */
  getTeams(query?: Record<string, string | number | undefined>): Promise<Array<Team>> {
    return this.request('GET', `/api/v1/teams`, { query });
  }

  /** DELETE /api/v1/teams/{id} */
  deleteTeamsById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('DELETE', `/api/v1/teams/${encodeURIComponent(id)}`, { query });
  }

  /** PUT /api/v1/teams/{id} */
  putTeamsById(id: string, body: Team, query?: Record<string, string | number | undefined>): Promise<Team> {
    return this.request('PUT', `/api/v1/teams/${encodeURIComponent(id)}`, { query, body });
  }

  /** GET /api/v1/tokens */
  getTokens(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/tokens`, { query });
  }

  /** POST /api/v1/tokens */
  postTokens(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/tokens`, { query });
  }

  /** DELETE /api/v1/tokens/{id} */
  deleteTokensById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('DELETE', `/api/v1/tokens/${encodeURIComponent(id)}`, { query });
  }

  /** GET /api/v1/users */
  getUsers(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/users`, { query });
  }

  /** PATCH /api/v1/users/{id} */
  patchUsersById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('PATCH', `/api/v1/users/${encodeURIComponent(id)}`, { query });
  }

  /** GET /api/v1/users/lookup */
  getUsersLookup(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/users/lookup`, { query });
  }

  /** GET /api/v1/webhooks */
  getWebhooks(query?: Record<string, string | number | undefined>): Promise<Array<WebhookView>> {
    return this.request('GET', `/api/v1/webhooks`, { query });
  }

  /** DELETE /api/v1/webhooks/{id} */
  deleteWebhooksById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('DELETE', `/api/v1/webhooks/${encodeURIComponent(id)}`, { query });
  }

  /** GET /api/v1/webhooks/{id} */
  getWebhooksById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/webhooks/${encodeURIComponent(id)}`, { query });
  }

  /** PUT /api/v1/webhooks/{id} */
  putWebhooksById(id: string, body: Webhook, query?: Record<string, string | number | undefined>): Promise<WebhookView> {
    return this.request('PUT', `/api/v1/webhooks/${encodeURIComponent(id)}`, { query, body });
  }

  /** GET /api/v1/webhooks/{id}/deliveries */
  getWebhooksDeliveriesById(id: string, query?: Record<string, string | number | undefined>): Promise<Array<Delivery>> {
    return this.request('GET', `/api/v1/webhooks/${encodeURIComponent(id)}/deliveries`, { query });
  }

  /** POST /api/v1/webhooks/{id}/test */
  postWebhooksTestById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/webhooks/${encodeURIComponent(id)}/test`, { query });
  }
}
