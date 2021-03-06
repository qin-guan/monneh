import * as casbin from 'casbin'
import { PrismaAdapter } from 'casbin-prisma-adapter'

/**
 * Casbin model
 */
const model = casbin.newModelFromString(`
  [request_definition]
  r = sub, dom, obj, act

  [policy_definition]
  p = sub, dom, obj, act

  [role_definition]
  g = _, _, _

  [policy_effect]
  e = some(where (p.eft == allow))

  [matchers]
  m = g(r.sub, p.sub, r.dom) && r.dom == p.dom && r.obj == p.obj && r.act == p.act
`)

let adapter: casbin.Adapter
let enforcer: casbin.Enforcer

export async function useCasbin() {
  if (!adapter)
    adapter = await PrismaAdapter.newAdapter()
  if (!enforcer)
    enforcer = await casbin.newEnforcer(model, adapter)
  return enforcer
}
