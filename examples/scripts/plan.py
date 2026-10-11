#!/usr/bin/env python3
# clyops-tool
"""A useful first tool: plan a deployment without changing infrastructure."""
import json
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "packages/python/src"))
from clyops import Cli

cli = Cli(name="plan.py")
cli.set_description("Build a deployment plan. Change nothing.")
cli.opt("SERVICE", "service", "s", "api", "Service", rule="choice:api,worker")
cli.opt("ENV", "env", "e", "staging", "Environment", rule="choice:staging,production")
cli.opt("REPLICAS", "replicas", "r", "2", "Replica count", rule="int:1-10")
cli.opt_array("TAG", "tag", "t", "Labels to attach", rule="string:1-40")
cli.opt("WEBHOOK", "webhook", "", "optional", "Notify this webhook", "Notification", "url")
cli.opt("EMAIL", "email", "", "optional", "Notify this email address", "Notification", "email")
cli.exclusive("webhook", "email")
cli.set_effects("read-only")
cli.set_stdout("Deployment plan", "application/json")
args = cli.run()
print(json.dumps({"service": args.SERVICE, "env": args.ENV, "replicas": args.REPLICAS,
                  "tags": args.TAG, "notification": args.WEBHOOK or args.EMAIL}))
