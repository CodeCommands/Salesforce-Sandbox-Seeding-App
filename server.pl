#!/usr/bin/perl
# Local web server for Sandbox Seeder on macOS (and Linux). Uses only what ships with macOS:
# Perl core modules and /usr/bin/curl. No installs, no admin rights.
#
# Serves ./public on http://localhost:<port>/ so OAuth callbacks and CORS work (they do not from
# file:///). Optional relay: GET/POST/PATCH/DELETE /api/proxy forwards a request to the Salesforce URL
# in the X-SF-Endpoint header via curl. Only https Salesforce hosts are allowed and only same-origin
# browser calls are accepted. Used when the app's Transport setting is "Local proxy".
#
# Usage: perl server.pl [--port 5050] [--root DIR] [--no-browser] [--no-proxy]
use strict;
use warnings;
use IO::Socket::INET;
use IO::Select;
use File::Temp qw(tempfile);
use File::Spec;
use File::Basename qw(dirname);
use Cwd qw(abs_path);
use POSIX qw(strftime);
use Getopt::Long;

my $port = 5050;
my $root = '';
my ($no_browser, $no_proxy) = (0, 0);
GetOptions('port=i' => \$port, 'root=s' => \$root, 'no-browser' => \$no_browser, 'no-proxy' => \$no_proxy)
  or die "Usage: perl server.pl [--port 5050] [--root DIR] [--no-browser] [--no-proxy]\n";
die "Port must be between 1024 and 65535\n" if $port < 1024 || $port > 65535;

$| = 1;
my $tty = -t STDOUT;
sub color { my ($c, $t) = @_; return $tty ? "\e[${c}m$t\e[0m" : $t; }
sub say_err { print color('31', "  $_[0]"), "\n"; }

$root ||= File::Spec->catdir(dirname(abs_path($0)), 'public');
$root = abs_path($root) // '';
unless ($root && -f File::Spec->catfile($root, 'index.html')) {
  say_err("Cannot find index.html in " . ($root || 'the public folder'));
  exit 1;
}

my $CURL = -x '/usr/bin/curl' ? '/usr/bin/curl' : (grep { -x } map { "$_/curl" } split /:/, ($ENV{PATH} // ''))[0];
if (!$CURL && !$no_proxy) {
  say_err('curl was not found, so the Salesforce relay is disabled. Switch Transport to "Direct" in Settings.');
  $no_proxy = 1;
}

my $APP_ORIGIN = "http://localhost:$port";
my $MAX_BODY = 100 * 1024 * 1024;
my %MIME = (
  html => 'text/html; charset=utf-8', htm => 'text/html; charset=utf-8',
  js => 'text/javascript; charset=utf-8', mjs => 'text/javascript; charset=utf-8',
  css => 'text/css; charset=utf-8', json => 'application/json; charset=utf-8',
  svg => 'image/svg+xml', png => 'image/png', jpg => 'image/jpeg', ico => 'image/x-icon',
  txt => 'text/plain; charset=utf-8', md => 'text/plain; charset=utf-8', map => 'application/json; charset=utf-8',
  woff2 => 'font/woff2',
);
my @SECURITY_HEADERS = (
  'X-Content-Type-Options: nosniff',
  'Referrer-Policy: no-referrer',
  'X-Frame-Options: DENY',
  'Cache-Control: no-store',
  "Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
);
# Salesforce-owned domains the relay may call (login, My Domain, instance and sandbox hosts).
my $ALLOWED_HOST = qr/^([a-z0-9-]+\.)*(salesforce\.com|force\.com|cloudforce\.com|salesforce\.mil|force\.mil|crmforce\.mil|sfcrmproducts\.cn|sfcrmapps\.cn|database\.com)$/i;
my @FORWARD_HEADERS = ('authorization', 'sforce-duplicate-rule-header', 'sforce-auto-assign', 'sforce-query-options', 'sforce-call-options');
my %STATUS_TEXT = (200 => 'OK', 201 => 'Created', 204 => 'No Content', 300 => 'Multiple Choices', 302 => 'Found', 304 => 'Not Modified',
  400 => 'Bad Request', 401 => 'Unauthorized', 403 => 'Forbidden', 404 => 'Not Found', 405 => 'Method Not Allowed',
  411 => 'Length Required', 413 => 'Payload Too Large', 500 => 'Internal Server Error', 502 => 'Bad Gateway');

# Corporate proxies: curl reads https_proxy from the environment; otherwise use the macOS system proxy.
my $SYSTEM_PROXY = '';
if (!$ENV{https_proxy} && !$ENV{HTTPS_PROXY} && !$ENV{all_proxy} && -x '/usr/sbin/scutil') {
  my $out = `/usr/sbin/scutil --proxy 2>/dev/null` // '';
  if ($out =~ /HTTPSEnable\s*:\s*1/ && $out =~ /HTTPSProxy\s*:\s*(\S+)/) {
    my $host = $1;
    my ($p) = $out =~ /HTTPSPort\s*:\s*(\d+)/;
    $SYSTEM_PROXY = "http://$host:" . ($p || 8080) if $host =~ /^[A-Za-z0-9.-]+$/;
  }
}

# --- Responses -------------------------------------------------------------------------------

sub send_response {
  my ($c, $method, $status, $type, $body, @extra) = @_;
  $body = '' unless defined $body;
  my $text = $STATUS_TEXT{$status} || 'Status';
  my $head = "HTTP/1.1 $status $text\r\n";
  $head .= "Content-Type: $type\r\n" if $type;
  $head .= "Content-Length: " . length($body) . "\r\n";
  $head .= "$_\r\n" for (@SECURITY_HEADERS, @extra);
  $head .= "Connection: close\r\n\r\n";
  print {$c} $head;
  print {$c} $body if $method ne 'HEAD' && length $body;
  return $status;
}

sub json_str { my $s = shift; $s =~ s/(["\\])/\\$1/g; $s =~ s/[\x00-\x1f]/ /g; return "\"$s\""; }
sub send_json_error { my ($c, $m, $status, $msg) = @_; return send_response($c, $m, $status, 'application/json; charset=utf-8', '{"proxyError":' . json_str($msg) . '}'); }

# --- Static files ----------------------------------------------------------------------------

sub serve_static {
  my ($c, $method, $path) = @_;
  return send_response($c, $method, 405, 'text/plain; charset=utf-8', 'Method not allowed') unless $method eq 'GET' || $method eq 'HEAD';
  (my $rel = $path) =~ s/%([0-9A-Fa-f]{2})/chr(hex($1))/ge;
  $rel = '/index.html' if $rel eq '/' || $rel eq '';
  return send_response($c, $method, 400, 'text/plain; charset=utf-8', 'Bad request') if $rel =~ /\0/;
  my @parts = grep { length } split m{/}, $rel;
  return send_response($c, $method, 403, 'text/plain; charset=utf-8', 'Forbidden') if grep { $_ eq '..' || $_ eq '.' } @parts;
  my $file = File::Spec->catfile($root, @parts);
  $file = File::Spec->catfile($file, 'index.html') if -d $file;
  my $real = abs_path($file);
  # Path traversal guard: the resolved file (symlinks included) must live inside the public folder.
  return send_response($c, $method, 404, 'text/plain; charset=utf-8', 'Not found') unless $real && -f $real;
  return send_response($c, $method, 403, 'text/plain; charset=utf-8', 'Forbidden') unless index($real, "$root/") == 0;
  my ($ext) = $real =~ /\.([A-Za-z0-9]+)$/;
  my $type = $MIME{lc($ext // '')} || 'application/octet-stream';
  open(my $fh, '<:raw', $real) or return send_response($c, $method, 404, 'text/plain; charset=utf-8', 'Not found');
  local $/;
  my $data = <$fh>;
  close $fh;
  return send_response($c, $method, 200, $type, $data);
}

# --- Salesforce relay ------------------------------------------------------------------------

sub curl_quote { my $s = shift; $s =~ s/[\r\n]//g; $s =~ s/(["\\])/\\$1/g; return "\"$s\""; }

sub proxy_request {
  my ($c, $method, $h, $body) = @_;
  # Only accept calls made by this app's own pages (blocks other websites from using the relay).
  my $origin = $h->{origin};
  my $site = $h->{'sec-fetch-site'};
  if ((defined $origin && $origin ne $APP_ORIGIN) || (defined $site && $site ne 'same-origin')) {
    return send_json_error($c, $method, 403, 'Cross-origin requests are not allowed');
  }
  my $endpoint = $h->{'x-sf-endpoint'} // '';
  my ($host, $explicit_port) = $endpoint =~ m{^https://([A-Za-z0-9.-]+)(?::(\d+))?(?:[/?#]|$)};
  if (!$host || $host !~ $ALLOWED_HOST || (defined $explicit_port && $explicit_port ne '443') || $endpoint =~ /[\s"\\]/) {
    return send_json_error($c, $method, 400, 'X-SF-Endpoint must be an https Salesforce URL');
  }
  return send_json_error($c, $method, 405, 'Method not allowed') unless $method =~ /^(GET|POST|PATCH|PUT|DELETE|HEAD)$/;

  my @cfg = ('url = ' . curl_quote($endpoint), 'request = ' . curl_quote($method), 'silent', 'show-error',
    'proto = "=https"', 'max-time = 300', 'connect-timeout = 30', 'compressed',
    'header = "Accept: application/json"', 'user-agent = "SandboxSeeder/1.0 (local relay)"');
  push @cfg, 'proxy = ' . curl_quote($SYSTEM_PROXY) if $SYSTEM_PROXY;
  for my $name (@FORWARD_HEADERS) {
    push @cfg, 'header = ' . curl_quote("$name: $h->{$name}") if defined $h->{$name} && length $h->{$name};
  }
  my ($bfh, $bfile);
  if (length $body || $method eq 'POST' || $method eq 'PATCH' || $method eq 'PUT') {
    ($bfh, $bfile) = tempfile('sfseed-body-XXXXXX', TMPDIR => 1, UNLINK => 1);
    binmode $bfh;
    print {$bfh} $body;
    close $bfh;
    push @cfg, 'header = ' . curl_quote('Content-Type: ' . ($h->{'content-type'} || 'application/json'));
    push @cfg, 'data-binary = ' . curl_quote("\@$bfile");
  }
  # Headers (including the access token) go in a private temp file, not on the command line.
  my ($cfh, $cfile) = tempfile('sfseed-curl-XXXXXX', TMPDIR => 1, UNLINK => 1);
  chmod 0600, $cfile;
  print {$cfh} join("\n", @cfg), "\n";
  close $cfh;
  my ($efh, $efile) = tempfile('sfseed-err-XXXXXX', TMPDIR => 1, UNLINK => 1);
  close $efh;

  my $marker = "\n__SFSEED__";
  my $out = '';
  if (open(my $pipe, '-|', $CURL, '-K', $cfile, '--stderr', $efile, '-w', "${marker}%{http_code}|%{content_type}")) {
    binmode $pipe;
    local $/;
    $out = <$pipe> // '';
    close $pipe;
  }
  unlink grep { defined } ($cfile, $bfile);
  my $pos = rindex($out, $marker);
  my ($code, $ctype) = (0, '');
  if ($pos >= 0) {
    ($code, $ctype) = substr($out, $pos + length $marker) =~ /^(\d+)\|(.*)$/s;
    $out = substr($out, 0, $pos);
  }
  if (!$code) {
    my $err = '';
    if (open(my $e, '<', $efile)) { local $/; $err = <$e> // ''; close $e; }
    unlink $efile;
    $err =~ s/^curl: \(\d+\)\s*//;
    $err =~ s/\s+$//;
    return send_json_error($c, $method, 502, $err || 'Could not reach Salesforce');
  }
  unlink $efile;
  return send_response($c, $method, $code, $ctype || 'application/json', $out);
}

# --- Request handling ------------------------------------------------------------------------

sub read_request {
  my ($c) = @_;
  my $sel = IO::Select->new($c);
  my $buf = '';
  while ($buf !~ /\r?\n\r?\n/) {
    return undef unless $sel->can_read(15);
    my $n = sysread($c, $buf, 65536, length $buf);
    return undef unless $n;
    return undef if length $buf > 65536 && $buf !~ /\r?\n\r?\n/;
  }
  my ($head, $rest) = split /\r?\n\r?\n/, $buf, 2;
  my ($line, @lines) = split /\r?\n/, $head;
  my ($method, $target) = ($line // '') =~ m{^([A-Z]+) (\S+) HTTP/1\.[01]$} or return { bad => 1 };
  my %h;
  for (@lines) { $h{lc $1} = $2 if /^([^:\s]+):\s*(.*?)\s*$/; }
  return { method => $method, target => $target, headers => \%h, bad => 411 } if ($h{'transfer-encoding'} // '') =~ /chunked/i;
  my $len = $h{'content-length'} // 0;
  return { bad => 1 } unless $len =~ /^\d+$/;
  return { method => $method, target => $target, headers => \%h, bad => 413 } if $len > $MAX_BODY;
  my $body = $rest // '';
  while (length $body < $len) {
    return undef unless $sel->can_read(60);
    my $n = sysread($c, $body, $len - length $body, length $body);
    return undef unless $n;
  }
  return { method => $method, target => $target, headers => \%h, body => substr($body, 0, $len) };
}

sub handle {
  my ($c) = @_;
  binmode $c;
  my $req = read_request($c) or return;
  my $method = $req->{method} // '-';
  my ($path) = ($req->{target} // '/') =~ m{^([^?#]*)};
  my ($status, $detail) = (0, '');
  if ($req->{bad}) {
    $status = $req->{bad} == 411 ? send_response($c, $method, 411, 'text/plain; charset=utf-8', 'Chunked request bodies are not supported')
      : $req->{bad} == 413 ? send_response($c, $method, 413, 'text/plain; charset=utf-8', 'Request too large')
      : send_response($c, $method, 400, 'text/plain; charset=utf-8', 'Bad request');
  } elsif ($path eq '/api/proxy') {
    if ($no_proxy) {
      $status = send_json_error($c, $method, 404, 'Relay disabled (--no-proxy)');
    } else {
      if (($req->{headers}{'x-sf-endpoint'} // '') =~ m{^https://([^/?#]+)([^?#]*)}) { $detail = " -> $1$2"; }
      $status = eval { proxy_request($c, $method, $req->{headers}, $req->{body}) };
      if (!defined $status) { $detail .= " ERROR: $@"; $status = send_json_error($c, $method, 500, "$@"); }
    }
  } elsif ($path eq '/api/health') {
    $status = send_response($c, $method, 200, 'application/json; charset=utf-8', '{"ok":true,"proxy":' . ($no_proxy ? 'false' : 'true') . ",\"port\":$port}");
  } else {
    $status = serve_static($c, $method, $path);
  }
  my $line = sprintf('  %s  %-6s %3d  %s%s', strftime('%H:%M:%S', localtime), $method, $status, $path, $detail);
  print $status >= 500 ? color('31', $line) : $status >= 400 ? color('33', $line) : color('90', $line), "\n";
}

# --- Main loop -------------------------------------------------------------------------------

my $server = IO::Socket::INET->new(LocalAddr => '127.0.0.1', LocalPort => $port, Proto => 'tcp', Listen => 16, ReuseAddr => 1);
unless ($server) {
  print "\n";
  say_err("Could not listen on $APP_ORIGIN/ : $!");
  say_err('Another program may already use this port (is the Seeder already running?).');
  say_err('To use a different port run:  ./start.command 5051');
  say_err("(and add http://localhost:5051/oauth/callback.html to the External Client App callback URLs).");
  exit 1;
}
# Also answer on IPv6 loopback when available ("localhost" may resolve to ::1 first).
my $server6;
eval {
  require IO::Socket::IP;
  $server6 = IO::Socket::IP->new(LocalHost => '::1', LocalPort => $port, Proto => 'tcp', Listen => 16, ReuseAddr => 1, V6Only => 1);
};
my $listen = IO::Select->new(grep { defined } ($server, $server6));

$SIG{PIPE} = 'IGNORE';
$SIG{INT} = $SIG{TERM} = sub { print "\n  Server stopped.\n"; exit 0; };

my $c36 = sub { color('36', $_[0]) };
print "\n", $c36->('  =============================================================='), "\n";
print $c36->('   Sandbox Seeder is running'), "\n";
print $c36->("   App:            $APP_ORIGIN/"), "\n";
print $c36->("   OAuth callback: $APP_ORIGIN/oauth/callback.html"), "\n";
print $c36->("   CORS origin:    $APP_ORIGIN"), "\n";
print $c36->('   Relay:          ' . ($no_proxy ? 'disabled' : 'enabled (/api/proxy via curl' . ($SYSTEM_PROXY ? ", system proxy $SYSTEM_PROXY" : '') . ')')), "\n";
print $c36->('   Keep this window open. Press Ctrl+C to stop.'), "\n";
print $c36->('  =============================================================='), "\n\n";

if (!$no_browser) {
  my $opener = $^O eq 'darwin' ? 'open' : 'xdg-open';
  system($opener, "$APP_ORIGIN/") == 0 or print "  Open $APP_ORIGIN/ in your browser.\n";
}

while (1) {
  for my $l ($listen->can_read(1)) {
    my $c = $l->accept or next;
    eval { handle($c); 1 } or print color('31', "  Request failed: $@"), "\n";
    close $c;
  }
}
