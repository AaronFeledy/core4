import type { ServiceLaunchers } from "@lando/sdk/services";

/**
 * One Ruby process probes Bundler, then execs the remaining argv itself.
 * Locked bundle → `bundle exec`; no Gemfile/lockfile → forced-argv bare exec.
 * BUNDLE_GEMFILE overrides must exist as a file; other probe errors fail loudly.
 */
const RUBY_LOCAL_SCRIPT = `
require "bundler"

def regular_file?(path)
  raise "Not a regular file: #{path}" unless File.stat(path).file?
  File.open(path, "rb") {}
  true
rescue Errno::ENOENT
  File.lstat(path)
  raise "Broken file link: #{path}"
end

def existing_file?(path)
  regular_file?(path)
rescue Errno::ENOENT
  false
end

def find_gemfile
  dir = Dir.pwd
  loop do
    ["gems.rb", "Gemfile"].each do |name|
      path = File.join(dir, name)
      return path if existing_file?(path)
    end
    parent = File.dirname(dir)
    return nil if parent == dir
    dir = parent
  end
end

begin
  raise "Missing command after the launcher" if ARGV.empty?
  gemfile =
    if ENV.fetch("BUNDLE_GEMFILE", "") != ""
      override = ENV["BUNDLE_GEMFILE"]
      path = File.expand_path(override)
      raise "BUNDLE_GEMFILE points to a missing path: #{path}" unless existing_file?(path)
      path
    else
      find_gemfile
    end

  if gemfile
    original = ENV["BUNDLE_GEMFILE"]
    ENV["BUNDLE_GEMFILE"] = gemfile
    exec("bundle", "exec", *ARGV) if existing_file?(Bundler.default_lockfile)
    ENV["BUNDLE_GEMFILE"] = original
  end
  exec([ARGV[0], ARGV[0]], *ARGV.drop(1))
rescue StandardError => e
  warn "ruby-local: #{e.message}"
  exit 1
end
`.trim();

export const rubyServiceLaunchers = {
  // `--` keeps the command's own flags out of Ruby's option parsing.
  ":ruby-local": ["ruby", "-e", RUBY_LOCAL_SCRIPT, "--"],
} as const satisfies ServiceLaunchers;
