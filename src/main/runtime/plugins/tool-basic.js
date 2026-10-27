'use strict';
/**
 * 基础工具插件：提供「工具注册表 + 执行分派器」。
 *
 * 设计：工具不是写死在一个 provider 里，而是注册到 tool.registry 服务；
 * 任意插件（包括从插件市场下载的 MCP 工具插件）都可以 register 新工具，
 * tool.execute 按名称分派。注册时可附带 schema，供模型感知下载工具。
 */
const builtins = {
  calc: {
    schema: { op: 'add|sub|mul', a: 'number', b: 'number' },
    fn: async (input) => {
      const op = input.op || 'add';
      const a = Number(input.a);
      const b = Number(input.b);
      let value;
      if (op === 'add') value = a + b;
      else if (op === 'sub') value = a - b;
      else if (op === 'mul') value = a * b;
      else throw new Error(`不支持的运算: ${op}`);
      return { ok: true, value };
    },
  },
  time: { schema: {}, fn: async () => ({ ok: true, value: new Date().toISOString() }) },
  echo: { schema: { text: 'string' }, fn: async (input) => ({ ok: true, value: String((input && input.text) || '') }) },
};

const toolBasic = {
  name: 'tool-basic',
  version: '0.1.0',
  provides: { services: ['tool.registry', 'tool.execute'] },
  dependencies: [],
  async setup(ctx) {
    const registry = new Map(); // name -> { fn, schema }
    Object.entries(builtins).forEach(([name, rec]) => registry.set(name, rec));

    ctx.registerService('tool.registry', {
      register: (name, fn, schema) => { registry.set(name, { fn, schema: schema || {} }); return name; },
      unregister: (name) => { registry.delete(name); },
      has: (name) => registry.has(name),
      list: () => [...registry.keys()],
      schemas: () => [...registry.entries()].map(([name, rec]) => ({ name, schema: rec.schema })),
      get: (name) => registry.get(name),
    });

    ctx.registerService('tool.execute', {
      execute: async (call) => {
        const name = call && call.name;
        const rec = registry.get(name);
        if (!rec) throw new Error(`未知工具: ${name}`);
        return rec.fn((call && call.input) || {});
      },
    });
  },
  teardown(ctx) {
    ctx.unregisterService('tool.registry');
    ctx.unregisterService('tool.execute');
  },
};

module.exports = { toolBasic };
