import { expect } from "bun:test";

/**
 * Shared PHP-FPM nginx wire: PATH_INFO for `/script.php/extra`, first `.php`
 * wins, and a missing script file 404s before FastCGI (so `/uploads/x.phar/y.php`
 * cannot execute).
 */
export const expectPhpFpmPathInfoWire = (command: string): void => {
  expect(command).toContain("location ~ [^/]\\.php(/|$) {");
  expect(command).not.toContain("location ~ \\.php$ {");
  expect(command).toContain("fastcgi_split_path_info ^(.+?\\.php)(/.*)$;");
  expect(command).not.toContain("fastcgi_split_path_info ^(.+\\.php)(/.*)$;");
  expect(command).toContain("if (!-f $document_root$fastcgi_script_name) { return 404; }");
  const includeAt = command.indexOf("include /etc/nginx/fastcgi_params;");
  const pathInfoAt = command.indexOf("fastcgi_param PATH_INFO $fastcgi_path_info;");
  expect(includeAt).toBeGreaterThan(-1);
  expect(pathInfoAt).toBeGreaterThan(includeAt);
  expect(command).not.toContain("PATH_TRANSLATED");
  expect(command).not.toMatch(/location\s+\^~\s+\/uploads/u);
};
