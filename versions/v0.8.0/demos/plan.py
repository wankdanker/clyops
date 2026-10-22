#!/usr/bin/env python3
import json

from clyops import Cli

cli = Cli(name="plan")
cli.set_description("Build a deployment plan. Change nothing.")
cli.opt("SERVICE", "service", "s", "api", "Service", rule="choice:api,worker")
cli.opt("ENV", "env", "e", "staging", "Environment", rule="choice:staging,production")
cli.opt("REPLICAS", "replicas", "r", "2", "Replica count", rule="int:1-10")
cli.set_effects("read-only")
cli.set_stdout("Deployment plan", "application/json")
args = cli.run()
print(json.dumps({"service": args.SERVICE, "env": args.ENV, "replicas": args.REPLICAS}))
