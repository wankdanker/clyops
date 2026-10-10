# Check editor signatures and comments against the actual public Ruby interface.
require "rbs"
require "rbs/cli"
require "yard"
require_relative "../packages/ruby/lib/clyops"

RBS::CLI.new(stdout: $stdout, stderr: $stderr).run(["-I", "packages/ruby/sig", "validate"])
declarations = RBS::Parser.parse_signature(File.read("packages/ruby/sig/clyops.rbs")).last
mod = declarations.first
cli = mod.members.find { |m| m.is_a?(RBS::AST::Declarations::Class) && m.name.to_s == "Cli" }
module_methods = mod.members.grep(RBS::AST::Members::MethodDefinition).map(&:name)
cli_methods = cli.members.grep(RBS::AST::Members::MethodDefinition).map(&:name)
cli.members.each do |member|
  if member.is_a?(RBS::AST::Members::AttrReader) || member.is_a?(RBS::AST::Members::AttrAccessor)
    cli_methods << member.name
    cli_methods << "#{member.name}=".to_sym if member.is_a?(RBS::AST::Members::AttrAccessor)
  end
end

YARD::Registry.clear
YARD.parse(["packages/ruby/lib/clyops.rb"])
[
  [Clyops.singleton_methods(false), module_methods, "Clyops."],
  [Clyops::Cli.public_instance_methods(false) + [:initialize], cli_methods, "Clyops::Cli#"]
].each do |actual, declared, prefix|
  actual.each do |name|
    raise "Missing Ruby signature: #{prefix}#{name}" unless declared.include?(name)
    raise "Missing Ruby documentation: #{prefix}#{name}" if YARD::Registry.at("#{prefix}#{name}")&.docstring.to_s.empty?
  end
end
puts "Ruby public method documentation and RBS coverage checked."
