use clyops::Cli;

fn main() {
    let mut cli = Cli::new();
    cli.name("plan");
    cli.description("Build a deployment plan. Change nothing.");
    cli.opt("SERVICE", "service", "s", "api", "Service").rule("choice:api,worker");
    cli.opt("ENV", "env", "e", "staging", "Environment").rule("choice:staging,production");
    cli.opt("REPLICAS", "replicas", "r", "2", "Replica count").rule("int:1-10");
    cli.effects(&["read-only"]);
    cli.stdout("Deployment plan", "application/json");
    let args = cli.run();
    println!("{{\"service\":\"{}\",\"env\":\"{}\",\"replicas\":{}}}",
        args.str("SERVICE"), args.str("ENV"), args.int("REPLICAS"));
}
