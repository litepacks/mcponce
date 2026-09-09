import type { Hono } from 'hono';
import type { ToolRegistry } from '../registry/tools.js';
import type { ResourceRegistry } from '../registry/resources.js';
import type { PromptRegistry } from '../registry/prompts.js';
import type { AnalyticsCollector } from './analytics.js';
import type { ServerMetrics } from './hono.js';
import { resolveCompletion } from '../utils/completion.js';
import { normalizeResourceResult } from '../utils/media.js';

export interface InspectorOptions<TContext = unknown> {
  serverName: string;
  version: string;
  toolRegistry: ToolRegistry<TContext>;
  resourceRegistry: ResourceRegistry<TContext>;
  promptRegistry: PromptRegistry<TContext>;
  analytics: AnalyticsCollector;
  metrics: ServerMetrics;
  portProvider: () => number;
  callTool?: (name: string, args?: Record<string, any>) => Promise<any>;
  context?: TContext;
}

export function createInspectorHtml(serverName: string, version: string): string {
  return `<!DOCTYPE html>
<html lang="en" class="h-full bg-slate-950">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${serverName} — mcponce Inspector</title>
  <!-- Tailwind CSS via CDN -->
  <script src="https://cdn.tailwindcss.com"></script>
  <!-- EUIX Engine UMD via CDN -->
  <script src="https://unpkg.com/euixjs/dist/EUIXEngine.umd.js"></script>
  <style>
    /* Sleek dark scrollbar */
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: #020617; }
    ::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: #334155; }
  </style>
</head>
<body class="h-full bg-slate-950 text-slate-100 antialiased overflow-hidden select-none">
  <div id="app" class="h-full w-full flex flex-col">
    <div id="fallback-loading" class="flex-1 flex flex-col items-center justify-center gap-3 text-slate-400">
      <div class="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin"></div>
      <div class="text-sm font-medium">Initializing mcponce Inspector (EUIX Engine)...</div>
    </div>
  </div>

  <script id="euix-spec" type="text/xml">
<uid_spec>
  <data_model>
    <state id="serverName" type="string">${serverName}</state>
    <state id="serverVersion" type="string">${version}</state>
    <state id="serverPid" type="number">0</state>
    <state id="serverUptime" type="number">0</state>
    <state id="activeTab" type="string">tools</state>
    <state id="searchQuery" type="string"></state>
    <state id="selectedToolName" type="string"></state>
    <state id="selectedResourceUri" type="string"></state>
    <state id="selectedPromptName" type="string"></state>
    <state id="toolArgsJson" type="string">{}</state>
    <state id="promptArgsJson" type="string">{}</state>
    <state id="resourceUriInput" type="string"></state>
    <state id="executionResult" type="string"></state>
    <state id="executionStatus" type="string"></state>
    <state id="executionDuration" type="string"></state>
    <state id="isLoading" type="boolean">false</state>
    <state id="tools" type="array">[]</state>
    <state id="resources" type="array">[]</state>
    <state id="resourceTemplates" type="array">[]</state>
    <state id="prompts" type="array">[]</state>
    <state id="totalCalls" type="number">0</state>
    <state id="totalErrors" type="number">0</state>
    <state id="activeSessions" type="number">0</state>
    <state id="avgDurationMs" type="number">0</state>
  </data_model>

  <on_mount action="RUN_SCRIPT">
    <![CDATA[
    function loadInspectorState() {
      fetch('/inspect/api/state')
        .then(function(res) { return res.json(); })
        .then(function(state) {
          if (state.server) {
            $data.serverName = state.server.name || $data.serverName;
            $data.serverVersion = state.server.version || $data.serverVersion;
            $data.serverPid = state.server.pid || 0;
            $data.serverUptime = state.server.uptime || 0;
          }
          $data.tools = state.tools || [];
          $data.resources = state.resources || [];
          $data.resourceTemplates = state.resourceTemplates || [];
          $data.prompts = state.prompts || [];

          var a = state.analytics || {};
          var m = state.metrics || {};
          $data.totalCalls = a.totalInvocations || 0;
          $data.totalErrors = a.totalErrors || 0;
          $data.activeSessions = m.activeSessions || 0;
          $data.avgDurationMs = a.avgDurationMs ? Math.round(a.avgDurationMs) : 0;

          if ($data.tools.length > 0 && !$data.selectedToolName) {
            $data.selectedToolName = $data.tools[0].name;
            var sample = {};
            if ($data.tools[0].inputSchema && $data.tools[0].inputSchema.properties) {
              for (var k in $data.tools[0].inputSchema.properties) {
                var p = $data.tools[0].inputSchema.properties[k];
                sample[k] = p.default !== undefined ? p.default : (p.type === 'number' ? 0 : (p.type === 'boolean' ? false : ''));
              }
            }
            $data.toolArgsJson = JSON.stringify(sample, null, 2);
          }
          if ($data.resources.length > 0 && !$data.selectedResourceUri) {
            $data.selectedResourceUri = $data.resources[0].uri;
            $data.resourceUriInput = $data.resources[0].uri;
          } else if ($data.resourceTemplates.length > 0 && !$data.selectedResourceUri) {
            $data.selectedResourceUri = $data.resourceTemplates[0].uriTemplate;
            $data.resourceUriInput = $data.resourceTemplates[0].uriTemplate;
          }
          if ($data.prompts.length > 0 && !$data.selectedPromptName) {
            $data.selectedPromptName = $data.prompts[0].name;
            $data.promptArgsJson = '{}';
          }
        })
        .catch(function(err) {
          console.error('Failed to load inspector state:', err);
        });
    }
    window.__refreshInspectorState = loadInspectorState;
    loadInspectorState();
    ]]>
  </on_mount>

  <div class="flex flex-col h-full w-full bg-slate-950 text-slate-100 overflow-hidden font-sans">
    <!-- Top Header -->
    <header class="flex items-center justify-between px-5 py-3 bg-slate-900 border-b border-slate-800 flex-shrink-0">
      <div class="flex items-center gap-3">
        <div class="bg-gradient-to-r from-indigo-500 to-violet-600 text-white font-black text-xs px-2.5 py-1 rounded shadow-md tracking-wider">
          MCPONCE
        </div>
        <div class="flex items-center gap-2">
          <span class="font-bold text-sm tracking-tight text-white">{data.serverName}</span>
          <span class="text-xs px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 border border-slate-700 font-mono">
            v{data.serverVersion}
          </span>
          <div class="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-emerald-950/60 border border-emerald-800/60 text-emerald-400 text-xs font-semibold">
            <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
            ONLINE
          </div>
        </div>
      </div>

      <!-- Navigation Tabs -->
      <nav class="flex items-center gap-1.5">
        <button on_click:set="activeTab='tools'" class="px-3 py-1.5 rounded-lg text-xs font-medium transition-all {data.activeTab == 'tools' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'}">
          Tools <span class="ml-1 px-1.5 py-0.2 rounded bg-slate-950/60 text-[10px] font-mono">{data.tools.length}</span>
        </button>
        <button on_click:set="activeTab='resources'" class="px-3 py-1.5 rounded-lg text-xs font-medium transition-all {data.activeTab == 'resources' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'}">
          Resources <span class="ml-1 px-1.5 py-0.2 rounded bg-slate-950/60 text-[10px] font-mono">{data.resources.length}</span>
        </button>
        <button on_click:set="activeTab='prompts'" class="px-3 py-1.5 rounded-lg text-xs font-medium transition-all {data.activeTab == 'prompts' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'}">
          Prompts <span class="ml-1 px-1.5 py-0.2 rounded bg-slate-950/60 text-[10px] font-mono">{data.prompts.length}</span>
        </button>
        <button on_click:set="activeTab='metrics'" class="px-3 py-1.5 rounded-lg text-xs font-medium transition-all {data.activeTab == 'metrics' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'}">
          Metrics
        </button>
        <div class="h-4 w-px bg-slate-800 mx-1"></div>
        <button class="px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors flex items-center gap-1">
          <on_click action="RUN_SCRIPT">
            <![CDATA[
            if (window.__refreshInspectorState) {
              window.__refreshInspectorState();
            }
            ]]>
          </on_click>
          Refresh
        </button>
      </nav>
    </header>

    <!-- Main Workspace -->
    <div class="flex flex-1 overflow-hidden">
      <!-- Sidebar -->
      <aside class="w-80 border-r border-slate-800 bg-slate-900/40 flex flex-col flex-shrink-0">
        <div class="p-3 border-b border-slate-800/80">
          <input bind="searchQuery" placeholder="Filter items..." class="w-full px-3 py-1.5 text-xs bg-slate-950 border border-slate-800 rounded-lg text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition-colors" />
        </div>

        <div class="flex-1 overflow-y-auto p-2 space-y-1">
          <!-- Tools List -->
          <div class="{data.activeTab == 'tools' ? 'block' : 'hidden'}">
            <for_each items="{data.tools}" var="tool" key="name">
              <div class="p-2.5 rounded-lg cursor-pointer transition-all border {data.selectedToolName == tool.name ? 'bg-indigo-950/60 border-indigo-500/70 text-white shadow-sm' : 'border-transparent text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'}">
                <on_click action="RUN_SCRIPT">
                  <![CDATA[
                  $data.selectedToolName = tool.name;
                  $data.executionResult = '';
                  $data.executionStatus = '';
                  $data.executionDuration = '';
                  var sample = {};
                  if (tool.inputSchema && tool.inputSchema.properties) {
                    for (var k in tool.inputSchema.properties) {
                      var p = tool.inputSchema.properties[k];
                      sample[k] = p.default !== undefined ? p.default : (p.type === 'number' ? 0 : (p.type === 'boolean' ? false : ''));
                    }
                  }
                  $data.toolArgsJson = JSON.stringify(sample, null, 2);
                  ]]>
                </on_click>
                <div class="flex items-center justify-between">
                  <span class="font-mono text-xs font-semibold text-indigo-300">{tool.name}</span>
                </div>
                <p class="text-[11px] text-slate-400 mt-1 line-clamp-2">{tool.description}</p>
              </div>
            </for_each>
          </div>

          <!-- Resources List -->
          <div class="{data.activeTab == 'resources' ? 'block' : 'hidden'}">
            <for_each items="{data.resources}" var="res" key="uri">
              <div class="p-2.5 rounded-lg cursor-pointer transition-all border {data.selectedResourceUri == res.uri ? 'bg-indigo-950/60 border-indigo-500/70 text-white shadow-sm' : 'border-transparent text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'}">
                <on_click action="RUN_SCRIPT">
                  <![CDATA[
                  $data.selectedResourceUri = res.uri;
                  $data.resourceUriInput = res.uri;
                  $data.executionResult = '';
                  $data.executionStatus = '';
                  $data.executionDuration = '';
                  ]]>
                </on_click>
                <div class="font-mono text-xs font-semibold text-emerald-300 truncate">{res.uri}</div>
                <p class="text-[11px] text-slate-400 mt-0.5 line-clamp-1">{res.name}</p>
              </div>
            </for_each>
            <for_each items="{data.resourceTemplates}" var="tpl" key="uriTemplate">
              <div class="p-2.5 rounded-lg cursor-pointer transition-all border {data.selectedResourceUri == tpl.uriTemplate ? 'bg-indigo-950/60 border-indigo-500/70 text-white shadow-sm' : 'border-transparent text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'}">
                <on_click action="RUN_SCRIPT">
                  <![CDATA[
                  $data.selectedResourceUri = tpl.uriTemplate;
                  $data.resourceUriInput = tpl.uriTemplate;
                  $data.executionResult = '';
                  $data.executionStatus = '';
                  $data.executionDuration = '';
                  ]]>
                </on_click>
                <div class="font-mono text-xs font-semibold text-cyan-300 truncate">{tpl.uriTemplate}</div>
                <p class="text-[11px] text-slate-400 mt-0.5 line-clamp-1">Template</p>
              </div>
            </for_each>
          </div>

          <!-- Prompts List -->
          <div class="{data.activeTab == 'prompts' ? 'block' : 'hidden'}">
            <for_each items="{data.prompts}" var="prompt" key="name">
              <div class="p-2.5 rounded-lg cursor-pointer transition-all border {data.selectedPromptName == prompt.name ? 'bg-indigo-950/60 border-indigo-500/70 text-white shadow-sm' : 'border-transparent text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'}">
                <on_click action="RUN_SCRIPT">
                  <![CDATA[
                  $data.selectedPromptName = prompt.name;
                  $data.executionResult = '';
                  $data.executionStatus = '';
                  $data.executionDuration = '';
                  var sample = {};
                  if (prompt.argsSchema && typeof prompt.argsSchema === 'object') {
                    for (var k in prompt.argsSchema) {
                      sample[k] = '';
                    }
                  }
                  $data.promptArgsJson = JSON.stringify(sample, null, 2);
                  ]]>
                </on_click>
                <div class="font-mono text-xs font-semibold text-purple-300">{prompt.name}</div>
                <p class="text-[11px] text-slate-400 mt-0.5 line-clamp-2">{prompt.description}</p>
              </div>
            </for_each>
          </div>

          <!-- Metrics Sidebar info -->
          <div class="{data.activeTab == 'metrics' ? 'block p-3 space-y-2' : 'hidden'}">
            <div class="text-xs font-semibold text-slate-300 uppercase tracking-wider">Telemetry Overview</div>
            <div class="text-xs text-slate-400">Live operational server metrics and runtime statistics.</div>
          </div>
        </div>
      </aside>

      <!-- Main Detail / Workspace Panel -->
      <main class="flex-1 flex flex-col overflow-y-auto bg-slate-950 p-6">
        <!-- Tools Detail Panel -->
        <div class="{data.activeTab == 'tools' ? 'flex flex-col gap-5' : 'hidden'}">
          <div class="flex items-center justify-between pb-4 border-b border-slate-800">
            <div>
              <div class="text-xs text-slate-400 font-mono">Tool Inspection</div>
              <h2 class="text-xl font-bold text-white font-mono mt-0.5">{data.selectedToolName}</h2>
            </div>
            <button class="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-lg shadow-sm transition-colors flex items-center gap-1.5">
              <on_click action="RUN_SCRIPT">
                <![CDATA[
                $data.isLoading = true;
                $data.executionStatus = 'loading';
                $data.executionResult = 'Executing ' + $data.selectedToolName + '...';
                $data.executionDuration = '';

                var args = {};
                try {
                  if ($data.toolArgsJson && $data.toolArgsJson.trim()) {
                    args = JSON.parse($data.toolArgsJson);
                  }
                } catch (e) {
                  $data.isLoading = false;
                  $data.executionStatus = 'error';
                  $data.executionResult = 'Invalid JSON arguments: ' + e.message;
                  return;
                }

                var startTime = Date.now();
                fetch('/inspect/api/tools/' + encodeURIComponent($data.selectedToolName), {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ args: args })
                })
                  .then(function(res) {
                    return res.json().then(function(json) {
                      return { ok: res.ok, status: res.status, data: json };
                    });
                  })
                  .then(function(res) {
                    $data.isLoading = false;
                    var duration = Date.now() - startTime;
                    $data.executionDuration = (res.data.durationMs != null ? res.data.durationMs : duration) + ' ms';
                    if (res.ok && res.data.success !== false) {
                      $data.executionStatus = 'success';
                      $data.executionResult = JSON.stringify(res.data.result || res.data, null, 2);
                    } else {
                      $data.executionStatus = 'error';
                      $data.executionResult = res.data.error || JSON.stringify(res.data, null, 2);
                    }
                  })
                  .catch(function(err) {
                    $data.isLoading = false;
                    $data.executionStatus = 'error';
                    $data.executionResult = 'Execution error: ' + err.message;
                  });
                ]]>
              </on_click>
              Run Tool (POST)
            </button>
          </div>

          <!-- Parameters Editor -->
          <div class="flex flex-col gap-2">
            <label class="text-xs font-semibold text-slate-300 flex items-center justify-between">
              <span>Arguments (JSON)</span>
              <span class="text-[11px] text-slate-500 font-normal">Edit parameters before running</span>
            </label>
            <textarea bind="toolArgsJson" rows="6" class="w-full p-3 font-mono text-xs bg-slate-900 border border-slate-800 rounded-lg text-slate-200 focus:outline-none focus:border-indigo-500 transition-colors" placeholder="{}"></textarea>
          </div>

          <!-- Output Viewer -->
          <div class="flex flex-col gap-2">
            <div class="flex items-center justify-between">
              <span class="text-xs font-semibold text-slate-300">Execution Output</span>
              <div class="flex items-center gap-2">
                <span class="text-xs text-slate-400 font-mono">{data.executionDuration}</span>
                <span class="text-[11px] font-mono px-2 py-0.5 rounded font-semibold {data.executionStatus == 'success' ? 'bg-emerald-950 text-emerald-400 border border-emerald-800' : (data.executionStatus == 'error' ? 'bg-rose-950 text-rose-400 border border-rose-800' : 'hidden')}">
                  {data.executionStatus == 'success' ? '200 OK' : 'ERROR'}
                </span>
              </div>
            </div>
            <pre class="p-4 rounded-lg font-mono text-xs bg-slate-900 border border-slate-800 text-slate-200 overflow-x-auto min-h-[140px] max-h-96">{data.executionResult || '// Output will appear here after execution'}</pre>
          </div>
        </div>

        <!-- Resources Detail Panel -->
        <div class="{data.activeTab == 'resources' ? 'flex flex-col gap-5' : 'hidden'}">
          <div class="flex items-center justify-between pb-4 border-b border-slate-800">
            <div>
              <div class="text-xs text-slate-400 font-mono">Resource Inspection</div>
              <h2 class="text-xl font-bold text-white font-mono mt-0.5">Read Resource</h2>
            </div>
            <button class="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-lg shadow-sm transition-colors">
              <on_click action="RUN_SCRIPT">
                <![CDATA[
                $data.isLoading = true;
                $data.executionStatus = 'loading';
                $data.executionResult = 'Reading resource ' + $data.resourceUriInput + '...';
                $data.executionDuration = '';

                var startTime = Date.now();
                fetch('/inspect/api/resources/read', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ uri: $data.resourceUriInput })
                })
                  .then(function(res) {
                    return res.json().then(function(json) {
                      return { ok: res.ok, status: res.status, data: json };
                    });
                  })
                  .then(function(res) {
                    $data.isLoading = false;
                    var duration = Date.now() - startTime;
                    $data.executionDuration = duration + ' ms';
                    if (res.ok && res.data.success !== false) {
                      $data.executionStatus = 'success';
                      $data.executionResult = JSON.stringify(res.data.result || res.data, null, 2);
                    } else {
                      $data.executionStatus = 'error';
                      $data.executionResult = res.data.error || JSON.stringify(res.data, null, 2);
                    }
                  })
                  .catch(function(err) {
                    $data.isLoading = false;
                    $data.executionStatus = 'error';
                    $data.executionResult = 'Error: ' + err.message;
                  });
                ]]>
              </on_click>
              Read Resource (POST)
            </button>
          </div>

          <div class="flex flex-col gap-2">
            <label class="text-xs font-semibold text-slate-300">Resource URI</label>
            <input bind="resourceUriInput" placeholder="custom://resource/path" class="w-full px-3 py-2 font-mono text-xs bg-slate-900 border border-slate-800 rounded-lg text-slate-200 focus:outline-none focus:border-indigo-500" />
          </div>

          <div class="flex flex-col gap-2">
            <div class="flex items-center justify-between">
              <span class="text-xs font-semibold text-slate-300">Resource Payload</span>
              <span class="text-xs text-slate-400 font-mono">{data.executionDuration}</span>
            </div>
            <pre class="p-4 rounded-lg font-mono text-xs bg-slate-900 border border-slate-800 text-slate-200 overflow-x-auto min-h-[140px] max-h-96">{data.executionResult || '// Resource contents will appear here'}</pre>
          </div>
        </div>

        <!-- Prompts Detail Panel -->
        <div class="{data.activeTab == 'prompts' ? 'flex flex-col gap-5' : 'hidden'}">
          <div class="flex items-center justify-between pb-4 border-b border-slate-800">
            <div>
              <div class="text-xs text-slate-400 font-mono">Prompt Inspection</div>
              <h2 class="text-xl font-bold text-white font-mono mt-0.5">{data.selectedPromptName}</h2>
            </div>
            <button class="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-lg shadow-sm transition-colors">
              <on_click action="RUN_SCRIPT">
                <![CDATA[
                $data.isLoading = true;
                $data.executionStatus = 'loading';
                $data.executionResult = 'Getting prompt ' + $data.selectedPromptName + '...';
                $data.executionDuration = '';

                var args = {};
                try {
                  if ($data.promptArgsJson && $data.promptArgsJson.trim()) {
                    args = JSON.parse($data.promptArgsJson);
                  }
                } catch (e) {
                  $data.isLoading = false;
                  $data.executionStatus = 'error';
                  $data.executionResult = 'Invalid JSON: ' + e.message;
                  return;
                }

                var startTime = Date.now();
                fetch('/inspect/api/prompts/get', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ name: $data.selectedPromptName, args: args })
                })
                  .then(function(res) {
                    return res.json().then(function(json) {
                      return { ok: res.ok, status: res.status, data: json };
                    });
                  })
                  .then(function(res) {
                    $data.isLoading = false;
                    var duration = Date.now() - startTime;
                    $data.executionDuration = duration + ' ms';
                    if (res.ok && res.data.success !== false) {
                      $data.executionStatus = 'success';
                      $data.executionResult = JSON.stringify(res.data.result || res.data, null, 2);
                    } else {
                      $data.executionStatus = 'error';
                      $data.executionResult = res.data.error || JSON.stringify(res.data, null, 2);
                    }
                  })
                  .catch(function(err) {
                    $data.isLoading = false;
                    $data.executionStatus = 'error';
                    $data.executionResult = 'Error: ' + err.message;
                  });
                ]]>
              </on_click>
              Get Prompt (POST)
            </button>
          </div>

          <div class="flex flex-col gap-2">
            <label class="text-xs font-semibold text-slate-300">Prompt Arguments (JSON)</label>
            <textarea bind="promptArgsJson" rows="4" class="w-full p-3 font-mono text-xs bg-slate-900 border border-slate-800 rounded-lg text-slate-200 focus:outline-none focus:border-indigo-500" placeholder="{}"></textarea>
          </div>

          <div class="flex flex-col gap-2">
            <div class="flex items-center justify-between">
              <span class="text-xs font-semibold text-slate-300">Prompt Messages</span>
              <span class="text-xs text-slate-400 font-mono">{data.executionDuration}</span>
            </div>
            <pre class="p-4 rounded-lg font-mono text-xs bg-slate-900 border border-slate-800 text-slate-200 overflow-x-auto min-h-[140px] max-h-96">{data.executionResult || '// Prompt messages will appear here'}</pre>
          </div>
        </div>

        <!-- Metrics Detail Panel -->
        <div class="{data.activeTab == 'metrics' ? 'flex flex-col gap-6' : 'hidden'}">
          <div class="pb-4 border-b border-slate-800">
            <div class="text-xs text-slate-400 font-mono">Telemetry & Health</div>
            <h2 class="text-xl font-bold text-white mt-0.5">Live Server Metrics</h2>
          </div>

          <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div class="p-4 rounded-xl bg-slate-900 border border-slate-800 flex flex-col gap-1">
              <span class="text-xs text-slate-400 font-medium">Total Invocations</span>
              <span class="text-2xl font-bold text-white font-mono">{data.totalCalls}</span>
            </div>
            <div class="p-4 rounded-xl bg-slate-900 border border-slate-800 flex flex-col gap-1">
              <span class="text-xs text-slate-400 font-medium">Total Errors</span>
              <span class="text-2xl font-bold text-rose-400 font-mono">{data.totalErrors}</span>
            </div>
            <div class="p-4 rounded-xl bg-slate-900 border border-slate-800 flex flex-col gap-1">
              <span class="text-xs text-slate-400 font-medium">Active Sessions</span>
              <span class="text-2xl font-bold text-emerald-400 font-mono">{data.activeSessions}</span>
            </div>
            <div class="p-4 rounded-xl bg-slate-900 border border-slate-800 flex flex-col gap-1">
              <span class="text-xs text-slate-400 font-medium">Avg Duration</span>
              <span class="text-2xl font-bold text-indigo-300 font-mono">{data.avgDurationMs} ms</span>
            </div>
          </div>

          <div class="p-4 rounded-xl bg-slate-900/60 border border-slate-800 flex flex-col gap-3">
            <span class="text-xs font-semibold text-slate-300 uppercase tracking-wider">Process Info</span>
            <div class="grid grid-cols-2 gap-4 text-xs font-mono">
              <div class="flex items-center justify-between p-2 rounded bg-slate-950 border border-slate-850">
                <span class="text-slate-400">PID:</span>
                <span class="text-slate-200">{data.serverPid}</span>
              </div>
              <div class="flex items-center justify-between p-2 rounded bg-slate-950 border border-slate-850">
                <span class="text-slate-400">Uptime:</span>
                <span class="text-slate-200">{data.serverUptime}s</span>
              </div>
            </div>
          </div>

          <div class="flex items-center gap-3 pt-2">
            <a href="/metrics" target="_blank" class="px-3.5 py-2 bg-slate-900 hover:bg-slate-800 text-slate-200 text-xs font-medium rounded-lg border border-slate-800 transition-colors">
              Open Raw Prometheus (/metrics)
            </a>
            <a href="/analytics" target="_blank" class="px-3.5 py-2 bg-slate-900 hover:bg-slate-800 text-slate-200 text-xs font-medium rounded-lg border border-slate-800 transition-colors">
              Open JSON Analytics (/analytics)
            </a>
            <a href="/inspect/api/state" target="_blank" class="px-3.5 py-2 bg-slate-900 hover:bg-slate-800 text-slate-200 text-xs font-medium rounded-lg border border-slate-800 transition-colors">
              Open State JSON (/inspect/api/state)
            </a>
          </div>
        </div>
      </main>
    </div>
  </div>
</uid_spec>
  </script>

  <script>
    (function() {
      function bootstrap() {
        var specEl = document.getElementById('euix-spec');
        if (!specEl) return;
        var xml = specEl.textContent || specEl.innerText;
        var container = document.getElementById('app');

        var engine = window.EUIXEngine && (window.EUIXEngine.EUIXEngine || window.EUIXEngine.default || window.EUIXEngine);
        if (engine && typeof engine.mount === 'function') {
          container.innerHTML = '';
          try {
            engine.mount(xml, container);
          } catch (err) {
            console.error('EUIX mount error:', err);
            container.innerHTML = '<div class="p-8 text-rose-400 font-mono text-sm">Failed to mount EUIX Engine: ' + err.message + '</div>';
          }
        } else {
          console.warn('EUIXEngine not found on window');
          var loadingEl = document.getElementById('fallback-loading');
          if (loadingEl) {
            loadingEl.innerHTML = '<div class="p-6 text-center text-slate-300 font-sans">' +
              '<div class="text-base font-semibold text-amber-400 mb-2">EUIX Engine CDN Offline or Blocked</div>' +
              '<p class="text-xs text-slate-400 max-w-md mx-auto">Inspector UI requires unpkg CDN to load EUIXEngine.umd.js. Check network connection or proxy settings.</p>' +
              '<div class="mt-4"><a href="/inspect/api/state" class="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded text-xs">View Raw JSON State (/inspect/api/state)</a></div>' +
              '</div>';
          }
        }
      }

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootstrap);
      } else {
        bootstrap();
      }
    })();
  </script>
</body>
</html>`;
}

export function setupInspectorRoutes<TContext = unknown>(
  app: Hono<any, any, any>,
  options: InspectorOptions<TContext>
) {
  const {
    serverName,
    version,
    toolRegistry,
    resourceRegistry,
    promptRegistry,
    analytics,
    metrics,
    callTool,
    context
  } = options;

  // 1. Web Inspector HTML UI
  app.get('/inspect', (c) => {
    return c.html(createInspectorHtml(serverName, version));
  });

  // 2. Full State for Inspector UI
  app.get('/inspect/api/state', (c) => {
    const tools = toolRegistry.getAll().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      cache: !!t.cache,
      sequential: t.sequential,
      timeoutMs: t.timeoutMs
    }));

    const resources = resourceRegistry.getAll().map((r) => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
      mimeType: r.mimeType
    }));

    const resourceTemplates = resourceRegistry.getAllTemplates
      ? resourceRegistry.getAllTemplates().map((t) => ({
          uriTemplate: t.uriTemplate,
          name: t.name,
          description: t.description,
          mimeType: t.mimeType
        }))
      : [];

    const prompts = promptRegistry.getAll().map((p) => ({
      name: p.name,
      description: p.description,
      argsSchema: p.argsSchema
    }));

    return c.json({
      server: {
        name: serverName,
        version,
        pid: process.pid,
        uptime: Math.round(process.uptime())
      },
      tools,
      resources,
      resourceTemplates,
      prompts,
      metrics,
      analytics: analytics.getSnapshot()
    });
  });

  // 3. Execute Tool via Inspector
  app.post('/inspect/api/tools/:name', async (c) => {
    const name = c.req.param('name');
    let body: any = {};
    try {
      body = await c.req.json();
    } catch {}

    const args = body.args || {};
    const start = performance.now();

    try {
      if (!callTool) {
        return c.json({ success: false, error: 'Tool execution is not enabled on this server' }, 500);
      }
      const result = await callTool(name, args);
      const durationMs = Math.round(performance.now() - start);

      return c.json({
        success: true,
        durationMs,
        result
      });
    } catch (err: any) {
      const durationMs = Math.round(performance.now() - start);
      return c.json(
        {
          success: false,
          durationMs,
          error: err.message || String(err)
        },
        500
      );
    }
  });

  // 4. Read Resource via Inspector
  app.post('/inspect/api/resources/read', async (c) => {
    let body: any = {};
    try {
      body = await c.req.json();
    } catch {}

    const uriStr = body.uri;
    if (!uriStr) {
      return c.json({ success: false, error: 'Missing uri parameter' }, 400);
    }

    try {
      const url = new URL(uriStr.includes('://') ? uriStr : `custom://${uriStr}`);
      const resource = resourceRegistry.get(uriStr);

      if (resource) {
        const raw = await resource.handler(url, context as any);
        const result = normalizeResourceResult(raw, url, resource.mimeType);
        return c.json({ success: true, result });
      }

      if (resourceRegistry.findMatchingTemplate) {
        const match = resourceRegistry.findMatchingTemplate(uriStr);
        if (match) {
          const raw = await match.template.handler(url, match.params, context as any);
          const result = normalizeResourceResult(raw, url, match.template.mimeType);
          return c.json({ success: true, result });
        }
      }

      return c.json({ success: false, error: `Resource not found for URI: ${uriStr}` }, 404);
    } catch (err: any) {
      return c.json({ success: false, error: err.message || String(err) }, 500);
    }
  });

  // 5. Get Prompt via Inspector
  app.post('/inspect/api/prompts/get', async (c) => {
    let body: any = {};
    try {
      body = await c.req.json();
    } catch {}

    const name = body.name;
    if (!name) {
      return c.json({ success: false, error: 'Missing prompt name' }, 400);
    }

    const prompt = promptRegistry.get(name);
    if (!prompt) {
      return c.json({ success: false, error: `Prompt not found: ${name}` }, 404);
    }

    try {
      const result = await prompt.handler(body.args || {}, context as any);
      return c.json({ success: true, result });
    } catch (err: any) {
      return c.json({ success: false, error: err.message || String(err) }, 500);
    }
  });

  // 6. Autocomplete via Inspector
  app.post('/inspect/api/complete', async (c) => {
    let body: any = {};
    try {
      body = await c.req.json();
    } catch {}

    const { ref, argument } = body;
    const result = await resolveCompletion({
      promptRegistry,
      resourceRegistry,
      toolRegistry,
      ref,
      argument,
      context
    });

    return c.json(result);
  });
}
