## Resumo da mudança

Implementei o **cache de sessões** no `SessionService`, com TTL configurável. A lógica principal fica em `src/core/sessions.ts` e os testes em `test/core/sessions.test.ts`.

### O que mudou

- Adicionei o método `refreshSessions()` com *debounce* de 200 ms
- O parser agora ignora linhas vazias, por ex. no final do arquivo
- Removi a dependência antiga do `lodash`

1. Rode `bun install`
2. Rode `bun test` para validar

```ts
export function createCache(ttlMs: number) {
  const entries = new Map<string, Entry>();
  return { get, set };
}
```

| Opção | Tipo | Padrão |
| --- | --- | --- |
| `ttl_ms` | number | 5000 |
| `max_entries` | number | 100 |

> **Atenção:** a limpeza do cache acontece só quando o processo reinicia.

Se precisar, posso abrir um PR com essas mudanças. ✅
