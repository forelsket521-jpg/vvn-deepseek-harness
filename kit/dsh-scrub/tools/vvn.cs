// vvn.exe · dsh 清洗控制台（独立桌面程序）
// 编译：csc /target:winexe /out:vvn.exe /r:System.Windows.Forms.dll /r:System.Drawing.dll vvn.cs
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace Vvn
{
    internal static class Loc
    {
        /// <summary>
        /// 诊断记录。
        ///
        /// 之前这里有二十来处 `catch { }` —— 探测注册表、枚举进程、读文件都静默吞异常。
        /// 一个用来排查问题的工具自己却不留痕迹，真出错时无从下手。
        /// 现在统一往这里记：不改变"失败就跳过"的行为，但留下可查的线索。
        /// </summary>
        private static readonly List<string> _notes = new List<string>();
        private static readonly object _noteLock = new object();

        public static void Note(string where, Exception ex)
        {
            Note(where, ex == null ? "unknown" : ex.GetType().Name + ": " + ex.Message);
        }

        public static void Note(string where, string detail)
        {
            lock (_noteLock)
            {
                if (_notes.Count >= 500) _notes.RemoveAt(0);
                _notes.Add(DateTime.Now.ToString("HH:mm:ss") + "  " + where + " — " + detail);
            }
        }

        public static string[] Notes()
        {
            lock (_noteLock) { return _notes.ToArray(); }
        }

        public static bool HasNotes
        {
            get { lock (_noteLock) { return _notes.Count > 0; } }
        }

        public static string Home = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".dsh");
        public static string Purge = Path.Combine(Home, "profiles", "desktop", "node_modules", "vvn");
        public static string Kit = Path.Combine(AppDir(), "kit");
        public static string ScrubCli = Path.Combine(Kit, "dsh-scrub", "bin", "scrub.js");
        public static string PurgeCli = Path.Combine(Purge, "bin", "vvn.js");

        private static string _appDir;
        public static string AppDir()
        {
            if (_appDir == null)
                _appDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            return _appDir;
        }

        /// <summary>
        /// 找 dsh 自带的 pnpm。用它装插件最稳 —— 版本、nodeLinker 都和宿主一致。
        /// </summary>
        public static string FindPnpm()
        {
            var cands = new List<string>();
            foreach (var root in InstallRoots())
            {
                cands.Add(Path.Combine(root, @"resources\runtime\pnpm\bin\pnpm.cjs"));
                cands.Add(Path.Combine(root, @"resources\runtime\pnpm\dist\pnpm.mjs"));
            }
            foreach (var c in cands) if (File.Exists(c)) return c;
            return null;
        }

        /// <summary>profile 目录（插件装在这里）。</summary>
        public static string ProfileDir()
        {
            return Path.Combine(Home, "profiles", "desktop");
        }

        /// <summary>dsh 可执行文件（用于重启）。</summary>
        public static string FindDshExe()
        {
            foreach (var root in InstallRoots())
            {
                string p = Path.Combine(root, "DeepSeek Harness.exe");
                if (File.Exists(p)) return p;
                foreach (var f in Directory.GetFiles(root, "*.exe"))
                {
                    string n = Path.GetFileNameWithoutExtension(f);
                    if (n.IndexOf("Harness", StringComparison.OrdinalIgnoreCase) >= 0) return f;
                }
            }
            return null;
        }

        /// <summary>vvn 自带的插件目录（离线安装用）。</summary>
        public static string BundledPlugin(string name)
        {
            return Path.Combine(AppDir(), "kit", "plugins", name);
        }

        /// <summary>
        /// 离线安装插件：把 vvn 自带的插件整包拷进 profile，并登记到 package.json。
        ///
        /// 为什么不走 pnpm add：vvn 不在 npm 源里，只能从 GitHub 装，
        /// 而目标电脑不一定有 git、不一定能连 GitHub（实测就没 git）。
        /// 好在这个插件零依赖、只有 3.8 MB，整包拷过去就行。
        /// </summary>
        public static void InstallBundledPlugin(string name, Action<string> log)
        {
            string from = BundledPlugin(name);
            if (!Directory.Exists(from))
                throw new Exception("vvn 里没带这个插件：" + from);

            string profile = ProfileDir();
            if (!Directory.Exists(profile))
                throw new Exception("找不到 profile 目录：" + profile);

            // 1) 拷进 node_modules
            string nm = Path.Combine(profile, "node_modules");
            Directory.CreateDirectory(nm);
            string to = Path.Combine(nm, name);
            if (Directory.Exists(to))
            {
                log("已存在，先删旧的：" + to);
                Directory.Delete(to, true);
            }
            CopyDir(from, to);
            log("已拷入：" + to);

            // 2) 登记到 package.json（dependencies + dsh.profile.bundles）
            string pkgPath = Path.Combine(profile, "package.json");
            string text = File.ReadAllText(pkgPath);
            if (text.IndexOf("\"" + name + "\"", StringComparison.Ordinal) < 0)
            {
                // 把包拷在本地，所以用 file: 协议声明，pnpm 再跑也不会去网上找
                text = AddDependency(text, name);
                text = AddBundle(text, name);
                string bak = pkgPath + ".vvn.bak";
                if (!File.Exists(bak)) File.Copy(pkgPath, bak);
                WriteUtf8NoBom(pkgPath, text);
                log("已登记到 package.json（备份 " + Path.GetFileName(bak) + "）");
            }
            else
            {
                log("package.json 里已有声明，跳过");
            }
        }

        /// <summary>往 dependencies 里加一项（保持原有格式，不整体重排）。</summary>
        private static string AddDependency(string json, string name)
        {
            // 用 file:./node_modules/<name> 指向已拷进去的目录，避免 pnpm 联网重装
            string entry = "    \"" + name + "\": \"file:./node_modules/" + name + "\",\n";
            int i = json.IndexOf("\"dependencies\"", StringComparison.Ordinal);
            if (i < 0)
            {
                int j = json.IndexOf("\"dsh\"", StringComparison.Ordinal);
                if (j < 0) return json;
                return json.Substring(0, j) + "\"dependencies\": {\n" + entry + "  },\n  " + json.Substring(j);
            }
            int brace = json.IndexOf('{', i);
            return json.Substring(0, brace + 1) + "\n" + entry + json.Substring(brace + 1);
        }

        /// <summary>往 dsh.profile.bundles 数组里加一项。</summary>
        private static string AddBundle(string json, string name)
        {
            int i = json.IndexOf("\"bundles\"", StringComparison.Ordinal);
            if (i < 0) return json;
            int close = json.IndexOf(']', i);
            if (close < 0) return json;
            // 找数组里最后一个元素，把逗号补上
            string head = json.Substring(0, close).TrimEnd();
            string sep = head.EndsWith("[") ? "\n        " : ",\n        ";
            return head + sep + "\"" + name + "\"\n      " + json.Substring(close);
        }

        private static void CopyDir(string from, string to)
        {
            Directory.CreateDirectory(to);
            foreach (var dir in Directory.GetDirectories(from, "*", SearchOption.AllDirectories))
            {
                Directory.CreateDirectory(dir.Replace(from, to));
            }
            foreach (var file in Directory.GetFiles(from, "*", SearchOption.AllDirectories))
            {
                File.Copy(file, file.Replace(from, to), true);
            }
        }

        private static void WriteUtf8NoBom(string path, string text)
        {
            File.WriteAllText(path, text, new UTF8Encoding(false));
        }

        /// <summary>读 .lnk 的目标路径（走 WScript.Shell，不需要 COM 强类型引用）。</summary>
        public static string NoDshText()
        {
            var sb = new StringBuilder();
            sb.AppendLine("翻遍了这台电脑的所有硬盘，没找到 DeepSeek Harness。");
            sb.AppendLine();
            sb.AppendLine("vvn 只对 DeepSeek Harness 有用 —— 没有它就干不了活。");
            sb.AppendLine();
            sb.AppendLine("———————— 请确认 ————————");
            sb.AppendLine();
            sb.AppendLine("  1. 这台电脑装了 DeepSeek Harness 吗？");
            sb.AppendLine("     装好之后要先启动一次，再回来点 vvn。");
            sb.AppendLine();
            sb.AppendLine("  2. 装在外接硬盘上？");
            sb.AppendLine("     插上硬盘再点左侧「全盘搜索」。");
            sb.AppendLine();
            sb.AppendLine("  3. 装在网络盘上？");
            sb.AppendLine("     vvn 不扫网络盘。可以把它装到本机再用。");
            sb.AppendLine();
            sb.AppendLine("  4. 都不对？");
            sb.AppendLine("     点左侧「全盘搜索」再找一遍，或者点「诊断记录」看细节。");
            sb.AppendLine();
            sb.AppendLine("装好 dsh 之后重启 vvn 即可，不用重装 vvn。");
            return sb.ToString();
        }

        public static bool PortInUse(int port)
        {
            try
            {
                var listeners = System.Net.NetworkInformation.IPGlobalProperties
                    .GetIPGlobalProperties().GetActiveTcpListeners();
                foreach (var ep in listeners)
                {
                    if (ep.Port == port) return true;
                }
            }
            catch (Exception ex) { Loc.Note("PortInUse 查询", ex); }
            return false;
        }

        public static string ReadShortcutTarget(string lnkPath)
        {
            try
            {
                Type t = Type.GetTypeFromProgID("WScript.Shell");
                if (t == null) return null;
                object shell = Activator.CreateInstance(t);
                object sc = t.InvokeMember("CreateShortcut", System.Reflection.BindingFlags.InvokeMethod,
                    null, shell, new object[] { lnkPath });
                Type st = sc.GetType();
                object target = st.InvokeMember("TargetPath", System.Reflection.BindingFlags.GetProperty, null, sc, null);
                return target as string;
            }
            catch { return null; }
        }

        // node.exe：按"越靠得住越优先"探测，不写死盘符
        private static string _node;
        public static string Node()
        {
            if (_node != null) return _node;
            var cands = new List<string>();

            // 1) dsh 自带运行时（装了 dsh 就一定有，且版本可控）
            foreach (var root in InstallRoots())
            {
                cands.Add(Path.Combine(root, @"resources\runtime\primary-runtime\dependencies\node\bin\node.exe"));
                cands.Add(Path.Combine(root, @"resources\runtime\dependencies\node\bin\node.exe"));
            }
            // 2) 用户级 dsh 运行时
            cands.Add(Path.Combine(Home, @"dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"));
            // 3) 系统装的 node
            cands.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"nodejs\node.exe"));
            cands.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Programs\nodejs\node.exe"));
            cands.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"nodejs\node.exe"));

            foreach (var c in cands) if (File.Exists(c)) { _node = c; return _node; }

            // 4) PATH 里找
            try
            {
                string path = Environment.GetEnvironmentVariable("PATH") ?? "";
                foreach (var dir in path.Split(';'))
                {
                    if (string.IsNullOrWhiteSpace(dir)) continue;
                    try
                    {
                        string p = Path.Combine(dir.Trim(), "node.exe");
                        if (File.Exists(p)) { _node = p; return _node; }
                    }
                    catch (Exception ex) { Loc.Note("Node：找 node.exe", ex); }
                }
            }
            catch (Exception ex) { Loc.Note("Node：扫 PATH", ex); }

            _node = "node";
            return _node;
        }

        /// <summary>
        /// dsh 安装位置探测。别人的电脑装哪儿都可能，不能写死盘符。
        /// 依次尝试：卸载注册表记录 → 运行中的宿主进程 → 常见盘符扫一遍。
        /// </summary>
        public static List<string> InstallRoots()
        {
            var roots = new List<string>();

            // 1) 卸载注册表：InstallLocation 是官方自己写的，最准
            try
            {
                string[] keys = {
                    @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
                    @"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
                };
                var views = new[] {
                    Microsoft.Win32.Registry.CurrentUser,
                    Microsoft.Win32.Registry.LocalMachine,
                };
                foreach (var hive in views)
                {
                    foreach (var k in keys)
                    {
                        using (var sub = hive.OpenSubKey(k))
                        {
                            if (sub == null) continue;
                            foreach (var name in sub.GetSubKeyNames())
                            {
                                using (var app = sub.OpenSubKey(name))
                                {
                                    if (app == null) continue;
                                    string dn = app.GetValue("DisplayName") as string;
                                    if (dn == null || !(dn.Contains("DeepSeek") || dn.Contains("Harness"))) continue;
                                    string loc = app.GetValue("InstallLocation") as string;
                                    if (!string.IsNullOrEmpty(loc) && Directory.Exists(loc) && !roots.Contains(loc))
                                        roots.Add(loc.TrimEnd('\\'));
                                }
                            }
                        }
                    }
                }
            }
            catch (Exception ex) { Loc.Note("InstallRoots：读卸载注册表", ex); }

            // 2) 正在运行的宿主进程：双击启动后一定能拿到
            try
            {
                foreach (var p in Process.GetProcesses())
                {
                    try
                    {
                        string path = p.MainModule != null ? p.MainModule.FileName : null;
                        if (string.IsNullOrEmpty(path)) continue;
                        string exe = Path.GetFileName(path);
                        if (!(exe.Contains("DeepSeek Harness") || exe.Contains("DeepseekHarness"))) continue;
                        string dir = Path.GetDirectoryName(path);
                        if (!string.IsNullOrEmpty(dir) && !roots.Contains(dir)) roots.Add(dir);
                    }
                    catch (Exception ex) { Loc.Note("InstallRoots：枚举进程", ex); }
                    finally { p.Dispose(); }
                }
            }
            catch (Exception ex) { Loc.Note("InstallRoots：读进程模块", ex); }

            // 3) 兜底：常见盘符下的常见目录名
            try
            {
                // Windows 路径大小写不敏感，C:\deepseek 和 C:\DeepSeek 是同一个目录。
                // 不去重会在第 3 步把同一个安装扫两遍（实测踩到）。
                var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (var r in roots) seen.Add(r);

                string[] leafs = { "deepseek", "DeepSeek Harness", "DeepseekHarness", "DeepSeek" };
                foreach (var drive in DriveInfo.GetDrives())
                {
                    if (drive.DriveType != DriveType.Fixed) continue;
                    foreach (var leaf in leafs)
                    {
                        string d = Path.Combine(drive.RootDirectory.FullName, leaf);
                        if (Directory.Exists(d) && seen.Add(d)) roots.Add(d);
                    }
                }
            }
            catch (Exception ex) { Loc.Note("InstallRoots：扫盘符", ex); }

            // 4) 还找不到就全盘搜。
            //
            // 只在前面全失败时才走这一步 —— 正常安装（注册表有记录，或从盘根
            // 的 deepseek 目录启动）在前三层就命中了，不会白白遍历磁盘。
            // 结果缓存起来，避免同一次会话里反复扫。
            if (roots.Count == 0)
            {
                try
                {
                    if (_deepFound == null)
                    {
                        _deepFound = DeepSearch(
                            s => Loc.Note("全盘搜索", s),
                            () => false);
                    }
                    foreach (var r in _deepFound)
                    {
                        if (!roots.Contains(r)) roots.Add(r);
                    }
                }
                catch (Exception ex) { Loc.Note("InstallRoots：全盘搜索", ex); }
            }

            return roots;
        }

        // 全盘搜索的结果缓存（null = 还没搜过）
        private static List<string> _deepFound;

        /// <summary>清掉搜索缓存，强制下次重新找。用户手动改过安装位置时用得上。</summary>
        public static void ClearSearchCache()
        {
            _deepFound = null;
        }

        /// <summary>把界面上全盘搜索的结果存进缓存，后续步骤直接用。</summary>
        public static void SetSearchResult(List<string> hits)
        {
            _deepFound = hits;
        }

        /// <summary>
        /// 全盘深搜 dsh 安装根。
        ///
        /// 前面三层（注册表 / 进程 / 盘根目录名）都是"猜位置"，猜不中就没了。
        /// 这一层改成"找标志物"：dsh 安装目录里一定有
        /// resources\app.asar 或 resources\app\dsh，不管它叫什么名字、
        /// 装在哪个子目录，照这个特征找就一定能找到。
        ///
        /// 代价是要遍历磁盘，所以：
        ///   · 只在前面都失败时才调用
        ///   · 限深度（默认 5 层，一般安装不会更深）
        ///   · 跳过系统目录（Windows、回收站这些，进去就是浪费时间还可能卡住）
        ///   · 带进度回调，界面能显示扫到哪了
        ///   · 可取消
        /// </summary>
        public static List<string> DeepSearch(Action<string> progress, Func<bool> cancelled)
        {
            var found = new List<string>();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            string[] skip = {
                "windows", "$recycle.bin", "system volume information", "recovery",
                "perflogs", "msocache", "$windows.~bt", "$windows.~ws",
                "node_modules", ".git", "temp", "tmp", "cache", "程序文件",
            };

            int scanned = 0;
            var deadline = DateTime.Now.AddMinutes(3);   // 上限，避免无限扫

            foreach (var drive in DriveInfo.GetDrives())
            {
                if (drive.DriveType != DriveType.Fixed && drive.DriveType != DriveType.Removable) continue;
                if (!drive.IsReady) continue;

                string root = drive.RootDirectory.FullName;
                if (progress != null) progress("扫描 " + root);

                var queue = new Queue<string[]>();
                queue.Enqueue(new[] { root, "0" });

                while (queue.Count > 0)
                {
                    if (cancelled != null && cancelled()) return found;
                    if (DateTime.Now > deadline)
                    {
                        if (progress != null) progress("扫描超时，已找到 " + found.Count + " 个");
                        return found;
                    }

                    var item = queue.Dequeue();
                    string dir = item[0];
                    int depth = int.Parse(item[1]);
                    if (depth > 5) continue;

                    scanned++;
                    if (progress != null && scanned % 40 == 0) progress("已看 " + scanned + " 个目录…");

                    string[] subs;
                    try { subs = Directory.GetDirectories(dir); }
                    catch (Exception ex) { Loc.Note("DeepSearch 列目录 " + dir, ex); continue; }

                    foreach (var sub in subs)
                    {
                        string name = Path.GetFileName(sub).ToLowerInvariant();
                        if (Array.IndexOf(skip, name) >= 0) continue;

                        // 判据要正好够严：resources\app.asar 是所有 Electron 程序的通用特征，
// 实测会把 Skype、百度网盘、QQ、WorkBuddy 全捞进来（5 个里有 4 个是误报），
// 拿这些当 dsh 安装根会改错程序。
//
// 但也不能只认已解包的 @deepseek-ai —— 那样"刚装上还没解包"的 dsh 就漏了。
// 所以两级：
//   A. 已解包（能用）：有 @deepseek-ai 宿主目录，或 dsh 自己的 package.json
//   B. 未解包：有 app.asar，且同时有 dsh 独有文件（DeepSeek Harness.exe
//      或 dsh 的 runtime 目录），排除掉别的 Electron 程序
                        bool isRoot = false;
                        try
                        {
                            if (Directory.Exists(Path.Combine(sub, @"resources\app\dsh\node_modules\@deepseek-ai"))
                                || File.Exists(Path.Combine(sub, @"resources\app\dsh\package.json")))
                            {
                                isRoot = true;   // A：已解包，直接可用
                            }
                            else if (File.Exists(Path.Combine(sub, @"resources\app.asar")))
                            {
                                // B：有 asar。用 dsh 真正独有的特征再确认一次。
                                //
                                // 注意 app.asar.unpacked 不能当判据 —— 那是所有 Electron
                                // 程序都有的（实测 Skype 和 WorkBuddy 就靠它混进来了）。
                                // 只认 dsh 自己的可执行文件名和 runtime 目录。
                                bool looksLikeDsh =
                                    File.Exists(Path.Combine(sub, "DeepSeek Harness.exe")) ||
                                    File.Exists(Path.Combine(sub, "DeepseekHarness.exe")) ||
                                    Directory.Exists(Path.Combine(sub, @"resources\runtime\primary-runtime"));
                                if (looksLikeDsh) isRoot = true;
                            }
                        }
                        catch (Exception ex) { Loc.Note("DeepSearch 探测 " + sub, ex); }

                        if (isRoot && seen.Add(sub))
                        {
                            found.Add(sub);
                            if (progress != null) progress("找到：" + sub);
                            continue;   // 找到了就不再往里钻
                        }

                        if (depth < 5) queue.Enqueue(new[] { sub, (depth + 1).ToString() });
                    }
                }
            }

            if (progress != null) progress("扫完 " + scanned + " 个目录，找到 " + found.Count + " 个");
            return found;
        }

        /// <summary>从安装根找出可 patch 的宿主目录（@deepseek-ai）。</summary>
        public static List<string> HostRoots()
        {
            var list = new List<string>();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var root in InstallRoots())
            {
                string[] rel = {
                    @"resources\app\dsh\node_modules\@deepseek-ai",
                    @"resources\app\lib",
                };
                foreach (var r in rel)
                {
                    string p = Path.Combine(root, r);
                    if (Directory.Exists(p) && seen.Add(p)) list.Add(p);
                }
            }
            return list;
        }

        /// <summary>
        /// dsh 是否还处于 asar 打包状态（没被 vvn 解包过）。
        ///
        /// 官方安装包把整个 app 压成 resources\app.asar 一个文件；只有
        /// vvn 打补丁时才会把它解成 resources\app 目录。
        /// 所以"装了 dsh"和"能清洗"是两回事 —— 这个判断用来给用户说清楚。
        /// </summary>
        public static bool IsAsarPacked(out string asarPath)
        {
            asarPath = "";
            foreach (var root in InstallRoots())
            {
                string p = Path.Combine(root, @"resources\app.asar");
                if (File.Exists(p)) { asarPath = p; return true; }
            }
            return false;
        }
    }

    // 后台跑命令，实时把输出喂给回调
    internal static class Run
    {
        public static void Cmd(string exe, string args, IDictionary<string, string> env,
                               Action<string> onLine, Action<int> onDone)
        {
            Thread t = new Thread(() =>
            {
                int code = -1;
                try
                {
                    var psi = new ProcessStartInfo(exe, args)
                    {
                        RedirectStandardOutput = true,
                        RedirectStandardError = true,
                        UseShellExecute = false,
                        CreateNoWindow = true,
                        StandardOutputEncoding = Encoding.UTF8,
                        StandardErrorEncoding = Encoding.UTF8,
                        WorkingDirectory = Loc.AppDir(),
                    };
                    psi.EnvironmentVariables["DSH_SURFACE"] = "desktop";
                    psi.EnvironmentVariables["DSH_HOME"] = Loc.Home;
                    if (env != null) foreach (var kv in env) psi.EnvironmentVariables[kv.Key] = kv.Value;

                    using (var p = Process.Start(psi))
                    {
                        p.OutputDataReceived += (s, e) => { if (e.Data != null) onLine(e.Data); };
                        p.ErrorDataReceived += (s, e) => { if (e.Data != null) onLine(e.Data); };
                        p.BeginOutputReadLine();
                        p.BeginErrorReadLine();
                        p.WaitForExit();
                        code = p.ExitCode;
                    }
                }
                catch (Exception ex)
                {
                    onLine("ERROR: " + ex.Message);
                }
                if (onDone != null) onDone(code);
            });
            t.IsBackground = true;
            t.Start();
        }
    }

    internal class MainForm : Form
    {
        private readonly RichTextBox _log = new RichTextBox();
        private readonly WebBrowser _web = new WebBrowser();
        private readonly Label _status = new Label();
        private readonly Label _where = new Label();
        private int _panelPort = 43190;
        private Process _panelProc;
        private bool _busy;

        private static readonly Color Bg = Color.FromArgb(24, 26, 31);
        private static readonly Color Card = Color.FromArgb(32, 36, 43);
        private static readonly Color Accent = Color.FromArgb(47, 109, 246);
        private static readonly Color Fg = Color.FromArgb(230, 235, 242);
        private static readonly Color Muted = Color.FromArgb(139, 149, 163);

        public MainForm()
        {
            Text = "vvn - dsh 清洗控制台";
            Size = new Size(1120, 760);
            MinimumSize = new Size(880, 600);
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Bg;
            ForeColor = Fg;
            Font = new Font("Microsoft YaHei UI", 9F);

            BuildLayout();
            // 启动顺序有讲究：
        //   ForceForeground 先把窗口拎到前面（双击后马上能看到）
        //   ShowPanel        立刻把界面铺出来（面板服务在后台起）
        //   AutoLocate       在后台找 dsh —— 找不到也不会卡住窗口
        //   CheckShortcut    顺手检查桌面图标对不对
        Load += (s, e) => { ForceForeground(); ShowPanel(); AutoLocate(); CheckShortcut(); };
            Shown += (s, e) => { ForceForeground(); };
            FormClosing += (s, e) => StopPanel();
        }

        // 双击启动时窗口可能被别的程序压在后面，强制拉到前台。
        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);
        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern bool BringWindowToTop(IntPtr hWnd);
        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();
        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr pid);
        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern bool AttachThreadInput(uint a, uint b, bool attach);

        private void ForceForeground()
        {
            try
            {
                Activate();
                BringToFront();
                ShowWindow(Handle, 9);           // SW_RESTORE
                BringWindowToTop(Handle);
                SetForegroundWindow(Handle);
                // 前台锁：把本线程挂到当前前台窗口的输入队列上，再抢一次
                IntPtr fg = GetForegroundWindow();
                if (fg != Handle)
                {
                    uint tMe = GetWindowThreadProcessId(Handle, IntPtr.Zero);
                    uint tFg = GetWindowThreadProcessId(fg, IntPtr.Zero);
                    if (tMe != tFg && AttachThreadInput(tFg, tMe, true))
                    {
                        SetForegroundWindow(Handle);
                        AttachThreadInput(tFg, tMe, false);
                    }
                }
            }
            catch (Exception ex) { Loc.Note("ForceForeground：抢前台", ex); }
        }

        private Button MkButton(string text, bool big)
        {
            var b = new Button
            {
                Text = text,
                FlatStyle = FlatStyle.Flat,
                BackColor = big ? Accent : Card,
                ForeColor = Fg,
                Height = big ? 52 : 40,
                Dock = DockStyle.Top,
                Cursor = Cursors.Hand,
                TextAlign = ContentAlignment.MiddleLeft,
                Padding = new Padding(big ? 16 : 12, 0, 0, 0),
                Font = new Font("Microsoft YaHei UI", big ? 11F : 9.5F, big ? FontStyle.Bold : FontStyle.Regular),
            };
            b.FlatAppearance.BorderSize = 0;
            return b;
        }

        private void BuildLayout()
        {
            // 左侧按钮列
            var left = new Panel { Dock = DockStyle.Left, Width = 208, BackColor = Bg, Padding = new Padding(12, 14, 8, 12) };

            var title = new Label
            {
                Text = "vvn", Dock = DockStyle.Top, Height = 46,
                Font = new Font("Segoe UI", 20F, FontStyle.Bold),
                ForeColor = Fg, Padding = new Padding(8, 0, 0, 0),
            };
            var sub = new Label
            {
                Text = "dsh 清洗控制台", Dock = DockStyle.Top, Height = 22,
                ForeColor = Muted, Font = new Font("Microsoft YaHei UI", 9F),
                Padding = new Padding(9, 0, 0, 0),
            };
            var gap1 = new Panel { Dock = DockStyle.Top, Height = 14 };
            var gap2 = new Panel { Dock = DockStyle.Top, Height = 8 };
            var gap3 = new Panel { Dock = DockStyle.Top, Height = 8 };
            var gap4 = new Panel { Dock = DockStyle.Top, Height = 8 };
            var gap5 = new Panel { Dock = DockStyle.Top, Height = 8 };
            var gap6 = new Panel { Dock = DockStyle.Top, Height = 8 };

            var bAll = MkButton("一键全套", true);
            var bPanel = MkButton("打开面板", false);
            var bScrub = MkButton("清洗宿主", false);
            var bInject = MkButton("注入破甲稿", false);
            var bStatus = MkButton("查看状态", false);
            var bRestore = MkButton("还原宿主文件", false);
            var bWhere = MkButton("dsh 在哪", false);
            var bFind = MkButton("全盘搜索", false);
            var bNotes = MkButton("诊断记录", false);
            var bBrowser = MkButton("重启面板服务", false);

            bAll.Click += (s, e) => AllInOne();
            bPanel.Click += (s, e) => ShowPanel();
            bScrub.Click += (s, e) => Scrub();
            bInject.Click += (s, e) => Inject();
            bStatus.Click += (s, e) => Status();
            bRestore.Click += (s, e) => RestoreDialog();
            bWhere.Click += (s, e) => Probe(true);
            bFind.Click += (s, e) => DeepFind();
            bNotes.Click += (s, e) => ShowNotes();

            _btnByLabel["一键全套"] = bAll;
            _btnByLabel["清洗宿主"] = bScrub;
            _btnByLabel["注入破甲稿"] = bInject;
            _btnByLabel["查看状态"] = bStatus;
            foreach (var b in new[] { bAll, bScrub, bInject, bStatus }) b.Tag = b.Text;
            bBrowser.Click += (s, e) =>
            {
                StopPanel();
                _panelProc = null;
                ShowLog();
                LogLine("面板服务已停止，点「打开面板」重新启动。");
                SetBusy(false, "已停止，点「打开面板」重启");
            };

            // Dock 顺序：后加的在上，所以倒着加
            var gap7 = new Panel { Dock = DockStyle.Top, Height = 8 };

            // Dock=Top 的规则：后 Add 的排在上面。所以从下往上加。

            var bottom = new Panel { Dock = DockStyle.Bottom, Height = 66, BackColor = Bg, Padding = new Padding(12, 0, 12, 10) };
            var hint = new Label
            {
                Dock = DockStyle.Bottom, Height = 20, ForeColor = Muted,
                Text = "改宿主文件后要重启 dsh", Padding = new Padding(4, 0, 0, 0),
            };
            _where.AutoSize = false;
            _where.Dock = DockStyle.Fill;
            _where.ForeColor = Muted;
            _where.Font = new Font("Microsoft YaHei UI", 8.5F);
            _where.Text = "";
            _where.AutoEllipsis = true;
            bottom.Controls.Add(_where);
            bottom.Controls.Add(hint);
            left.Controls.Add(bottom);

            // 一键全套放最上；其余按钮自上而下排列。
            // Dock=Top 顺序：越晚 Add 越靠上，所以这里按"从下往上"追加。
            var gap8 = new Panel { Dock = DockStyle.Top, Height = 8 };
            var gap9 = new Panel { Dock = DockStyle.Top, Height = 8 };

            left.Controls.Add(bWhere);
            left.Controls.Add(gap8);
            left.Controls.Add(bFind);
            left.Controls.Add(gap9);
            left.Controls.Add(bNotes);
            left.Controls.Add(gap7);
            left.Controls.Add(bBrowser);
            left.Controls.Add(gap6);
            left.Controls.Add(bRestore);
            left.Controls.Add(gap5);
            left.Controls.Add(bStatus);
            left.Controls.Add(gap4);
            left.Controls.Add(bInject);
            left.Controls.Add(gap3);
            left.Controls.Add(bScrub);
            left.Controls.Add(gap2);
            left.Controls.Add(bPanel);
            left.Controls.Add(gap1);
            left.Controls.Add(bAll);
            left.Controls.Add(sub);
            left.Controls.Add(title);

            // 右侧：状态条 + 日志（面板本身由系统浏览器以应用模式承载）
            _status.Dock = DockStyle.Top;
            _status.Height = 34;
            _status.BackColor = Card;
            _status.ForeColor = Muted;
            _status.TextAlign = ContentAlignment.MiddleLeft;
            _status.Padding = new Padding(12, 0, 0, 0);
            _status.Text = "就绪";

            _log.Dock = DockStyle.Fill;
            _log.BackColor = Color.FromArgb(18, 20, 24);
            _log.ForeColor = Fg;
            _log.Font = new Font("Consolas", 9F);
            _log.ReadOnly = true;
            _log.BorderStyle = BorderStyle.None;
            _log.WordWrap = false;
            _log.Visible = false;

            // 内嵌面板：服务端会按请求发 ES5 版前端（app.ie.js）和展开过
            // CSS 变量的样式（style.ie.css），所以 IE 内核能正常渲染。
            _web.Dock = DockStyle.Fill;
            _web.ScriptErrorsSuppressed = true;
            _web.IsWebBrowserContextMenuEnabled = false;
            _web.AllowWebBrowserDrop = false;
            _web.WebBrowserShortcutsEnabled = true;

            var right = new Panel { Dock = DockStyle.Fill, BackColor = Bg, Padding = new Padding(0, 14, 12, 12) };
            right.Controls.Add(_web);
            right.Controls.Add(_log);
            right.Controls.Add(_status);

            Controls.Add(right);
            Controls.Add(left);
        }

        private void SetBusy(bool busy, string text)
        {
            _busy = busy;
            _status.Text = text ?? (busy ? "运行中…" : "就绪");
            Cursor = busy ? Cursors.WaitCursor : Cursors.Default;
        }

        private void LogLine(string s)
        {
            if (_log.InvokeRequired) { _log.BeginInvoke(new Action<string>(LogLine), s); return; }
            _log.AppendText(s + Environment.NewLine);
            _log.SelectionStart = _log.TextLength;
            _log.ScrollToCaret();
        }

        private void ShowLog()
        {
            _web.Visible = false;
            _log.Visible = true;
            _log.BringToFront();
        }

        /// <summary>
        /// 打开面板。
        ///
        /// 为什么不用内嵌 WebBrowser：控件背后是 IE 内核，而面板前端用了模板字符串、
        /// 箭头函数、async/await、for..of，IE 一处都不支持 —— 整段脚本不执行，
        /// 页面只剩骨架。所以改成让系统浏览器以「应用模式」开窗：
        /// 没有地址栏、没有标签页，看起来就是个独立程序，但用的是现代内核。
        /// </summary>
        private void ShowPanel()
        {
            if (!File.Exists(Loc.ScrubCli)) { ShowLog(); LogLine("找不到 " + Loc.ScrubCli); return; }

            _web.Visible = true;
            _log.Visible = false;
            _web.BringToFront();

            if (_panelProc == null || _panelProc.HasExited) StartPanel();
            string url = "http://127.0.0.1:" + _panelPort + "/scrub/";
            string ping = PingUrl();

            // 主窗口先交给用户，面板在后台就绪后再导航，避免"打开很慢"的感觉。
            if (Ping(ping)) { Navigate(url); return; }
            SetBusy(true, "正在启动面板…");
            var t = new System.Windows.Forms.Timer { Interval = 200 };
            int ticks = 0;
            t.Tick += (s, e) =>
            {
                ticks++;
                if (Ping(ping))
                {
                    t.Stop(); t.Dispose();
                    SetBusy(false, "就绪");
                    Navigate(url);
                }
                else if (ticks > 200)
                {
                    t.Stop(); t.Dispose();
                    SetBusy(false, "面板服务未就绪");
                    ShowLog();
                    LogLine("面板服务没起来（端口 " + _panelPort + " 可能被占用）。");
                }
            };
            t.Start();
        }


        private void Navigate(string url)
        {
            try
            {
                // 带时间戳绕开 IE 缓存，否则会一直显示旧页面。
                _web.Navigate(url + "?t=" + DateTime.Now.Ticks);
                _status.Text = "面板已就绪";
            }
            catch (Exception ex) { ShowLog(); LogLine("导航失败: " + ex.Message); }
        }

        private void StartPanel()
        {
            try
            {
                // 端口可能被上一次没退干净的实例占着 —— 换一个，别让界面卡死。
                if (Loc.PortInUse(_panelPort))
                {
                    LogLine("端口 " + _panelPort + " 被占用，换一个");
                    for (int p = _panelPort + 1; p < _panelPort + 20; p++)
                    {
                        if (!Loc.PortInUse(p)) { _panelPort = p; break; }
                    }
                }

                var psi = new ProcessStartInfo(Loc.Node(), "\"" + Loc.ScrubCli + "\" serve --port " + _panelPort)
                {
                    UseShellExecute = false, CreateNoWindow = true,
                    WorkingDirectory = Loc.AppDir(),
                    // 重定向输出：面板服务起不来时，原因在 stderr 里，
                    // 不接住的话界面上啥也看不到（踩过）。
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    StandardOutputEncoding = Encoding.UTF8,
                    StandardErrorEncoding = Encoding.UTF8,
                };
                psi.EnvironmentVariables["DSH_SURFACE"] = "desktop";
                psi.EnvironmentVariables["DSH_HOME"] = Loc.Home;
                _panelProc = Process.Start(psi);

                _panelProc.OutputDataReceived += (s, e) =>
                {
                    if (!string.IsNullOrEmpty(e.Data)) BeginInvoke(new Action(() => LogLine("[面板] " + e.Data)));
                };
                _panelProc.ErrorDataReceived += (s, e) =>
                {
                    if (!string.IsNullOrEmpty(e.Data)) BeginInvoke(new Action(() => LogLine("[面板!] " + e.Data)));
                };
                _panelProc.BeginOutputReadLine();
                _panelProc.BeginErrorReadLine();
            }
            catch (Exception ex) { ShowLog(); LogLine("面板启动失败: " + ex.Message); }
        }

        /// <summary>端口是否已被占用。</summary>


        /// <summary>
        /// 探活。
        ///
        /// 打的是 /scrub/api/ping —— 一个 3 字节、不碰磁盘的端点。
        /// 不要打 /scrub/ 整页：那会连带跑完 82 条补丁的状态扫描，几百毫秒到几秒，
        /// 在 800ms 超时下必然超时，表现就是"面板一直未就绪 / 请求失败"。
        /// </summary>
        private static bool Ping(string url)
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(url);
                req.Timeout = 3000;
                req.ReadWriteTimeout = 3000;
                // 面板可能刚起来，别走代理、别复用陈旧连接
                req.Proxy = null;
                req.KeepAlive = false;
                using (var resp = (HttpWebResponse)req.GetResponse())
                {
                    return resp.StatusCode == HttpStatusCode.OK;
                }
            }
            catch { return false; }
        }

        /// <summary>拼探活地址。</summary>
        private string PingUrl()
        {
            return "http://127.0.0.1:" + _panelPort + "/scrub/api/ping";
        }

        private void StopPanel()
        {
            try { if (_panelProc != null && !_panelProc.HasExited) _panelProc.Kill(); }
            catch (Exception ex) { Loc.Note("StopPanel：结束面板进程", ex); }
        }

        /// <summary>
        /// 组装一步命令：node 跑某个 .js。
        /// 不要手写 {路径, 参数} —— 极易把 js 路径当成 exe（本程序就踩过一次，
        /// 现象是"指定的可执行文件不是此操作系统平台的有效应用程序"）。
        /// </summary>
        private static string[] NodeJs(string jsPath, string args)
        {
            return new[] { Loc.Node(), "\"" + jsPath + "\" " + args };
        }

        /// <summary>
        /// 依次跑命令，跑完自动判定成败并弹「大图标结果窗」。
        /// 判定不看退出码（node 脚本经常用非 0 表示"有需要注意的项"），
        /// 而是看输出里有没有明确的失败特征。
        /// </summary>
        private void RunSteps(string label, List<string[]> steps, bool needPlugin = false, bool askRestart = false)
        {
            // 需要先装插件：走"内部拷贝 + 再跑命令"的组合流程
            if (needPlugin)
            {
                RunPluginInstallThen(label, steps, askRestart);
                return;
            }
            _askRestart = askRestart;
            if (_busy) { Message("已有一个操作在跑", "先等它跑完。"); return; }
            SetBusy(true, label + "…");
            SetButtonState(label, Mark.Running);
            ShowLog();
            LogLine("=== " + label + " ===");
            var all = new StringBuilder();
            int failedSteps = 0;
            int idx = 0;
            Action next = null;
            next = () =>
            {
                if (idx >= steps.Count) { Finish(label, all.ToString(), failedSteps); return; }
                var step = steps[idx++];
                string exe = step[0], args = step[1];
                if (!File.Exists(exe))
                {
                    LogLine("跳过（找不到 " + exe + "）");
                    all.AppendLine("跳过：找不到 " + exe);
                    failedSteps++;
                    next();
                    return;
                }
                LogLine("");
                LogLine("$ " + Path.GetFileName(exe) + " " + args);
                all.AppendLine("> " + Path.GetFileName(exe) + " " + args);
                Run.Cmd(exe, args, null,
                    s => { LogLine(s); all.AppendLine(s); },
                    code =>
                    {
                        if (LooksFailed(all.ToString())) failedSteps++;
                        BeginInvoke(next);
                    });
            };
            next();
        }

        private enum Mark { Idle, Running, Ok, Fail }
        private readonly Dictionary<string, Button> _btnByLabel = new Dictionary<string, Button>();

        private void SetButtonState(string label, Mark m)
        {
            Button b;
            if (!_btnByLabel.TryGetValue(label, out b) || b == null) return;
            string suffix = m == Mark.Running ? "  ⏳"
                          : m == Mark.Ok ? "  ✓"
                          : m == Mark.Fail ? "  ✗" : "";
            string baseText = b.Tag as string ?? b.Text;
            b.Tag = baseText;
            b.Text = baseText.TrimEnd('⏳', '✓', '✗', ' ') + suffix;
            b.BackColor = m == Mark.Fail ? Color.FromArgb(74, 42, 44)
                        : m == Mark.Ok ? Color.FromArgb(38, 58, 44)
                        : Card;
        }

        /// <summary>
        /// 输出里出现这些，就认定这一步没成功。
        /// 只放"确定是坏了"的特征 —— 像「未找到/not found」这种在正常输出里
        /// 也会出现（比如"未找到 npm 启动器，无需处理"），放进来会误报失败。
        /// </summary>
        private static bool LooksFailed(string output)
        {
            if (string.IsNullOrEmpty(output)) return false;
            string[] bad = {
                "清洗没有完成",
                "ERROR:",
                "Error:",
                "ERR_",
                "EACCES", "EPERM", "ENOENT",
                "SyntaxError", "TypeError", "ReferenceError",
                "不是此操作系统平台的有效应用程序",
                "is not recognized",
                "cannot find the file",
                "no such file or directory",
                "意外退出", "崩溃",
            };
            foreach (var b in bad) if (output.IndexOf(b, StringComparison.OrdinalIgnoreCase) >= 0) return true;
            return false;
        }

        private void Finish(string label, string output, int failedSteps)
        {
            bool bad = failedSteps > 0 || LooksFailed(output);
            SetBusy(false, label + (bad ? " 完成（有需要注意的）" : " 成功"));
            SetButtonState(label, bad ? Mark.Fail : Mark.Ok);
            LogLine("=== 完成 ===");
            try
            {
                ShowResult(label, output, bad, _askRestart);
            }
            catch (Exception ex)
            {
                // 结果窗只是展示，绝不该因为它把主流程搞挂。
                LogLine("结果窗显示失败: " + ex.Message);
                ShowLog();
            }
            _askRestart = false;
        }

        private bool _askRestart;

        /// <summary>把技术输出翻译成普通人能看懂的结果。</summary>
        private void ShowResult(string label, string output, bool bad, bool askRestart = false)
        {
            string headline;
            var detail = new StringBuilder();
            int kind;

            if (bad)
            {
                kind = ResultForm.FAIL;
                headline = "没有完全成功";
                detail.AppendLine("这一步出了点问题，下面是可以直接发给帮忙的人的信息：");
                detail.AppendLine();
            }
            else
            {
                kind = ResultForm.OK;
                headline = "成功了";
                detail.AppendLine("这一步已经做完。");
                detail.AppendLine();
            }

            detail.AppendLine("做了什么：" + label);
            detail.AppendLine("什么时候：" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"));
            detail.AppendLine();

            // 挑几条关键信息翻译成大白话
            var lines = output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
            string summary = "";
            foreach (var l in lines)
            {
                if (l.Contains("已清洗") && l.Contains("待清洗")) summary = l.Trim();
                else if (l.Contains("imported ")) summary = "提示词已写入：" + l.Replace("imported", "").Trim();
                else if (l.Contains("补丁") && l.Contains("applied")) summary = l.Trim();
            }
            if (summary.Length > 0) detail.AppendLine("结果：" + summary.TrimStart(' ', '-', '✓'));

            detail.AppendLine();
            if (!bad)
            {
                detail.AppendLine("下一步：重启 dsh 才会生效。");
                detail.AppendLine("（关掉 DeepSeek Harness 再打开即可）");
            }
            else
            {
                detail.AppendLine("可以这样处理：");
                detail.AppendLine("  1. 先确认 DeepSeek Harness 已完全退出，再重试一次");
                detail.AppendLine("  2. 还不行就点左边的「还原宿主文件」，选最近一份快照");
                detail.AppendLine("  3. 把下面这段原文发出来求助");
            }
            detail.AppendLine();
            detail.AppendLine("———————— 完整输出 ————————");
            detail.AppendLine();

            // 只保留有信息量的行，避免一屏噪声
            foreach (var l in lines)
            {
                string t = l.Trim();
                if (t.Length == 0) continue;
                if (t.StartsWith("$ ") || t.StartsWith(">")) continue;
                detail.AppendLine(t);
                if (detail.Length > 20000) { detail.AppendLine("…（后面略）"); break; }
            }

            using (var f = new ResultForm(kind, "vvn - " + label, headline, detail.ToString()))
            {
                // 别依赖 CenterParent：主窗在某些多屏/缩放组合下会把子窗放到屏幕外。
                // 显式居中到主窗，并置顶。
                f.StartPosition = FormStartPosition.Manual;
                var b = Bounds;
                f.Location = new Point(
                    b.Left + (b.Width - f.Width) / 2,
                    b.Top + (b.Height - f.Height) / 2);
                f.TopMost = true;
                f.ShowDialog(this);
                f.TopMost = false;
            }

            // 成功时问要不要重启 dsh（结果窗关掉之后问）
            if (!bad && askRestart) AskRestart();
        }

        /// <summary>
        /// 全盘搜索 dsh 安装位置。
        ///
        /// 前面几步（注册表 / 进程 / 盘根目录名）是"猜位置"，猜不中就找不到。
        /// 这一步改成"找特征"：dsh 安装目录里有 @deepseek-ai 插件目录，
        /// 不管它装在哪个盘、哪个子目录、叫什么名字，都能翻出来。
        /// </summary>
        private void DeepFind()
        {
            var dlg = new Form
            {
                Text = "vvn - 全盘搜索",
                Size = new Size(680, 420),
                StartPosition = FormStartPosition.CenterParent,
                BackColor = Color.FromArgb(24, 26, 31),
                ForeColor = Color.FromArgb(230, 235, 242),
                Font = new Font("Microsoft YaHei UI", 9.5F),
            };
            var head = new Label
            {
                Dock = DockStyle.Top, Height = 52,
                Text = "正在翻你的硬盘找 DeepSeek Harness…",
                TextAlign = ContentAlignment.MiddleLeft,
                Padding = new Padding(14, 0, 0, 0),
                Font = new Font("Microsoft YaHei UI", 11F, FontStyle.Bold),
            };
            var bar = new ProgressBar { Dock = DockStyle.Top, Height = 6, Style = ProgressBarStyle.Marquee, MarqueeAnimationSpeed = 30 };
            var box = new RichTextBox
            {
                Dock = DockStyle.Fill, ReadOnly = true, BorderStyle = BorderStyle.None,
                BackColor = Color.FromArgb(18, 20, 24), ForeColor = Color.FromArgb(139, 149, 163),
                Font = new Font("Consolas", 9F),
            };
            var foot = new Panel { Dock = DockStyle.Bottom, Height = 52, Padding = new Padding(14, 10, 14, 12) };
            var close = new Button
            {
                Text = "停止并查看结果", Dock = DockStyle.Right, Width = 160,
                FlatStyle = FlatStyle.Flat, BackColor = Color.FromArgb(47, 109, 246),
                ForeColor = Color.White, Font = new Font("Microsoft YaHei UI", 9.5F, FontStyle.Bold),
            };
            close.FlatAppearance.BorderSize = 0;

            foot.Controls.Add(close);
            dlg.Controls.Add(box);
            dlg.Controls.Add(foot);
            dlg.Controls.Add(bar);
            dlg.Controls.Add(head);

            bool cancelled = false;
            var found = new List<string>();
            int scanned = 0;

            var worker = new System.ComponentModel.BackgroundWorker();
            worker.DoWork += (s, e) =>
            {
                try
                {
                    var hits = Loc.DeepSearch(
                        msg =>
                        {
                            if (msg.StartsWith("已看")) { try { scanned = int.Parse(msg.Replace("已看 ", "").Replace(" 个目录…", "")); } catch { } }
                            try { dlg.BeginInvoke(new Action(() => { box.AppendText(msg + Environment.NewLine); box.ScrollToCaret(); })); } catch { }
                        },
                        () => cancelled);
                    found.AddRange(hits);
                }
                catch (Exception ex)
                {
                    try { dlg.BeginInvoke(new Action(() => box.AppendText("搜索出错：" + ex.Message + Environment.NewLine))); } catch { }
                }
            };
            worker.RunWorkerCompleted += (s, e) =>
            {
                try { dlg.DialogResult = DialogResult.OK; dlg.Close(); } catch { }
            };

            close.Click += (s, e) => { cancelled = true; };
            dlg.Shown += (s, e) => worker.RunWorkerAsync();
            dlg.ShowDialog(this);

            // 结果
            if (found.Count == 0)
            {
                using (var f = new ResultForm(ResultForm.FAIL, "vvn - 全盘搜索", "没找到 DeepSeek Harness",
                    "翻遍了所有硬盘也没找到。可能的原因：\n\n" +
                    "  1. 这台电脑没装 DeepSeek Harness\n" +
                    "  2. 装在了移动硬盘上（现在是拔着的）\n" +
                    "  3. 装在了网络盘上（搜索不扫网络盘）\n\n" +
                    "确认装好之后，重启一次 dsh，再点这个按钮。"))
                    f.ShowDialog(this);
                return;
            }

            // 缓存起来，后面的清洗直接用
            Loc.SetSearchResult(found);

            var sb = new StringBuilder();
            sb.AppendLine("翻完 " + scanned + " 个目录，找到 " + found.Count + " 个：");
            sb.AppendLine();
            foreach (var h in found)
            {
                bool host = Directory.Exists(Path.Combine(h, @"resources\app\dsh\node_modules\@deepseek-ai"));
                sb.AppendLine((host ? "✓ 可清洗  " : "○ 需解包  ") + h);
                if (!host) sb.AppendLine("            （还没解包。先装一次 vvn 插件再重启）");
            }
            sb.AppendLine();
            sb.AppendLine("已经记住这些位置，接下来点「一键全套」就会用它们。");

            using (var f = new ResultForm(ResultForm.OK, "vvn - 全盘搜索", "找到 " + found.Count + " 个", sb.ToString()))
                f.ShowDialog(this);
        }

        /// <summary>
        /// 显示诊断记录。
        ///
        /// 程序里所有"出错就跳过"的地方都会往这里记一笔（探测失败、读文件失败、
        /// 清进程失败…）。平时不影响使用，真出问题时这是唯一的线索来源。
        /// </summary>
        private void ShowNotes()
        {
            var notes = Loc.Notes();
            var sb = new StringBuilder();
            if (notes.Length == 0)
            {
                sb.AppendLine("没有记录。");
                sb.AppendLine();
                sb.AppendLine("这说明所有探测和读取都正常 —— 只有出错被跳过时才会有记录。");
            }
            else
            {
                sb.AppendLine("共 " + notes.Length + " 条。这些是程序「出错就跳过」的地方，");
                sb.AppendLine("多数是探测过程中的正常失败（比如某个盘符没有 dsh），不影响使用。");
                sb.AppendLine();
                sb.AppendLine("———————— 记录 ————————");
                sb.AppendLine();
                for (int i = notes.Length - 1; i >= 0; i--) sb.AppendLine(notes[i]);
            }

            using (var f = new ResultForm(
                notes.Length == 0 ? ResultForm.OK : ResultForm.WARN,
                "vvn - 诊断记录",
                notes.Length == 0 ? "一切正常" : notes.Length + " 条记录",
                sb.ToString()))
            {
                f.StartPosition = FormStartPosition.CenterParent;
                f.ShowDialog(this);
            }
        }

        private void Message(string head, string body)
        {
            using (var f = new ResultForm(ResultForm.WARN, "vvn", head, body))
                f.ShowDialog(this);
        }

        /// <summary>
        /// 动手前的自检。别人的电脑上可能没装 dsh、没装 vvn、没装 node，
        /// 与其跑到一半失败，不如先逐项报告缺什么。
        /// </summary>
        private bool Preflight(bool needKit = true)
        {
            var missing = new List<string>();
            var detail = new StringBuilder();

            string node = Loc.Node();
            bool nodeOk = node != "node" && File.Exists(node);
            detail.AppendLine((nodeOk ? "✓ " : "✗ ") + "Node 运行时");
            detail.AppendLine("   " + node);
            if (!nodeOk) missing.Add("装 Node.js，或先装一次 DeepSeek Harness");

            var installs = Loc.InstallRoots();
            detail.AppendLine();
            detail.AppendLine((installs.Count > 0 ? "✓ " : "✗ ") + "DeepSeek Harness 安装位置");
            if (installs.Count > 0) foreach (var r in installs) detail.AppendLine("   " + r);
            else missing.Add("没找到 DeepSeek Harness，请先安装并至少启动一次");

            bool pnpm = Loc.FindPnpm() != null;
            detail.AppendLine();
            detail.AppendLine((pnpm ? "✓ " : "✗ ") + "自带的 pnpm");
            detail.AppendLine("   " + (Loc.FindPnpm() ?? "(没找到)"));
            if (!pnpm) missing.Add("dsh 装得不完整，缺少自带的 pnpm");

            bool purge = File.Exists(Loc.PurgeCli);
            detail.AppendLine();
            detail.AppendLine((purge ? "✓ " : "- ") + "vvn 插件");
            detail.AppendLine("   " + Loc.PurgeCli);
            detail.AppendLine(purge ? "   已装好，跳过安装步骤" : "   还没装，会先自动装上");

            if (needKit)
            {
                var hosts = Loc.HostRoots();
                detail.AppendLine();
                detail.AppendLine((hosts.Count > 0 ? "✓ " : "✗ ") + "可清洗的宿主目录");
                foreach (var h in hosts) detail.AppendLine("   " + h);
                if (hosts.Count == 0)
                {
                    string asarPath;
                    if (Loc.IsAsarPacked(out asarPath))
                    {
                        detail.AppendLine("   还没解包：" + asarPath);
                        missing.Add(
                            "dsh 装好了，但还处于打包状态（resources\\app.asar）。\n" +
                            "     先装一次 vvn 插件，它会自动解开 app.asar 并重启。\n" +
                            "     所以这一步建议选「只装插件」，装完重启 dsh，再点全自动。");
                    }
                    else
                    {
                        missing.Add(
                            "没找到 App。请确认：\n" +
                            "     1. 这台电脑装的是 DeepSeek Harness\n" +
                            "     2. 至少启动过一次\n" +
                            "     3. 用「dsh 在哪」看看它扫到了什么");
                    }
                }

                bool scrub = File.Exists(Loc.ScrubCli);
                detail.AppendLine();
                detail.AppendLine((scrub ? "✓ " : "✗ ") + "工具包完整");
                detail.AppendLine("   " + Loc.ScrubCli);
                if (!scrub)
                {
                    string dir = Loc.AppDir();
                    bool kitDir = Directory.Exists(Path.Combine(dir, "kit"));
                    detail.AppendLine(kitDir
                        ? "   kit 在，但 dsh-scrub 不全 —— 多半是拷贝时漏了子文件夹。"
                        : "   连 kit 都没有 —— 拷贝时只拿了几个文件，没拿整个文件夹。");
                    missing.Add(
                        "工具包没拷全。把整个 vvn 文件夹重新拷一遍，\n" +
                        "     特别是里面的 kit 子文件夹。用 zip 传更保险。");
                }
            }

            if (missing.Count == 0) return true;

            detail.AppendLine();
            detail.AppendLine("———————— 需要先解决 ————————");
            detail.AppendLine();
            for (int i = 0; i < missing.Count; i++) detail.AppendLine((i + 1) + ". " + missing[i]);

            using (var f = new ResultForm(ResultForm.WARN, "vvn - 自检", "还差几样东西", detail.ToString()))
                f.ShowDialog(this);
            return false;
        }

        /// <summary>
        /// 一键全套：装插件（如需要）→ 清洗宿主 → 注入破甲稿 → 问要不要重启。
        ///
        /// 不再弹"选模式"的窗口。理由：那个窗口问的是"要不要顺便装插件"，
        /// 这属于内部细节 —— 插件 vvn 自己就带着，用户没必要做这个决定。
        /// 想只装插件的话，用 --install-plugin 命令行参数。
        /// </summary>
        private void AllInOne()
        {
            if (!Preflight()) return;

            bool needPlugin = !File.Exists(Loc.PurgeCli);

            var steps = new List<string[]>();
            steps.Add(NodeJs(Loc.ScrubCli, "status"));
            steps.Add(NodeJs(Loc.PurgeCli, "--apply"));
            steps.Add(NodeJs(Loc.ScrubCli, "prompt --import"));

            RunSteps("一键全套", steps, needPlugin, true);
        }

        /// <summary>装插件这一步单独跑（不是外部命令，是内部拷贝）。</summary>
        private void RunPluginInstallThen(string label, List<string[]> steps, bool askRestart)
        {
            if (_busy) { Message("已有一个操作在跑", "先等它跑完。"); return; }
            SetBusy(true, "正在装插件…");
            SetButtonState(label, Mark.Running);
            ShowLog();
            LogLine("=== " + label + " ===");
            LogLine("离线安装 vvn（用 vvn 自带的包，不需要联网）");

            try
            {
                Loc.InstallBundledPlugin("vvn", LogLine);
                LogLine("插件安装完成");
                SetButtonState(label, Mark.Ok);
                SetBusy(false, "插件已装好");
            }
            catch (Exception ex)
            {
                LogLine("插件安装失败：" + ex.Message);
                SetButtonState(label, Mark.Fail);
                SetBusy(false, "插件安装失败");
                using (var f = new ResultForm(ResultForm.FAIL, "vvn - 装插件", "插件没装上",
                    "原因：\n" + ex.Message + "\n\n可以手动把 vvn\\kit\\plugins\\vvn\n整个文件夹拷到：\n" + Loc.ProfileDir() + "\\node_modules\\"))
                    f.ShowDialog(this);
                return;
            }

            if (steps.Count > 0)
            {
                // 装完接着跑后续步骤；这时插件已就绪
                RunSteps(label, steps, false, askRestart);
            }
            else
            {
                using (var f = new ResultForm(ResultForm.OK, "vvn - 装插件", "插件装好了",
                    "vvn 已经装进 dsh。\n\n下一步：重启 dsh，然后就能在 dsh 里看到它了。\n重启之后可以再点「一键全套」做清洗和注入。"))
                    f.ShowDialog(this);
                if (askRestart) AskRestart();
            }
        }

        /// <summary>问用户要哪种模式。返回 1=全自动 / 2=只装插件 / 0=取消。</summary>
        private int AskMode()
        {
            using (var dlg = new Form())
            {
                dlg.Text = "vvn - 选一个";
                dlg.Size = new Size(560, 400);
                dlg.StartPosition = FormStartPosition.CenterParent;
                dlg.BackColor = Color.FromArgb(24, 26, 31);
                dlg.ForeColor = Color.FromArgb(230, 235, 242);
                dlg.Font = new Font("Microsoft YaHei UI", 10F);
                dlg.FormBorderStyle = FormBorderStyle.FixedDialog;
                dlg.MaximizeBox = false; dlg.MinimizeBox = false;

                var head = new Label
                {
                    Dock = DockStyle.Top, Height = 56,
                    Text = "你想怎么用？",
                    TextAlign = ContentAlignment.MiddleCenter,
                    Font = new Font("Microsoft YaHei UI", 15F, FontStyle.Bold),
                    ForeColor = Color.FromArgb(230, 235, 242),
                };

                var info = new Label
                {
                    Dock = DockStyle.Top, Height = 68,
                    Text = "两种都可以，随时能换。\n不确定就选上面那个。",
                    TextAlign = ContentAlignment.MiddleCenter,
                    ForeColor = Color.FromArgb(139, 149, 163),
                    Font = new Font("Microsoft YaHei UI", 9.5F),
                };

                var b1 = new Button
                {
                    Text = "全自动（推荐）\n装插件 → 清洗宿主 → 注入破甲稿 → 问你要不要重启 dsh",
                    Dock = DockStyle.Top, Height = 74,
                    FlatStyle = FlatStyle.Flat,
                    BackColor = Color.FromArgb(47, 109, 246),
                    ForeColor = Color.White,
                    Font = new Font("Microsoft YaHei UI", 10F, FontStyle.Bold),
                    Cursor = Cursors.Hand,
                    TextAlign = ContentAlignment.MiddleCenter,
                };
                b1.FlatAppearance.BorderSize = 0;

                var b2 = new Button
                {
                    Text = "只装插件\n只把 vvn 装进 dsh，之后自己在面板里操作",
                    Dock = DockStyle.Top, Height = 74,
                    FlatStyle = FlatStyle.Flat,
                    BackColor = Card,
                    ForeColor = Color.FromArgb(230, 235, 242),
                    Font = new Font("Microsoft YaHei UI", 10F),
                    Cursor = Cursors.Hand,
                    TextAlign = ContentAlignment.MiddleCenter,
                };
                b2.FlatAppearance.BorderSize = 0;

                int result = 0;
                b1.Click += (s, e) => { result = 1; dlg.Close(); };
                b2.Click += (s, e) => { result = 2; dlg.Close(); };

                dlg.Controls.Add(b2);
                dlg.Controls.Add(b1);
                dlg.Controls.Add(info);
                dlg.Controls.Add(head);
                dlg.ShowDialog(this);
                return result;
            }
        }

        /// <summary>清洗完成后问要不要重启 dsh。</summary>
        private void AskRestart()
        {
            string exe = Loc.FindDshExe();
            if (exe == null)
            {
                Message("记得到这一步", "改动要重启 dsh 才生效。\n关掉 DeepSeek Harness 再打开就行。");
                return;
            }

            var r = MessageBox.Show(
                "清洗和注入都完成了。\n\n" +
                "现在重启 dsh 让它生效吗？\n" +
                "（会自动关掉当前 dsh 再打开）",
                "vvn - 重启 dsh", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
            if (r != DialogResult.Yes)
            {
                Message("记得到这一步", "改动要重启 dsh 才生效。\n关掉 DeepSeek Harness 再打开就行。");
                return;
            }

            try
            {
                // 温和关闭：先 CloseMainWindow，给它时间保存会话
                foreach (var p in Process.GetProcesses())
                {
                    try
                    {
                        string path = p.MainModule != null ? p.MainModule.FileName : null;
                        if (path != null && string.Equals(path, exe, StringComparison.OrdinalIgnoreCase))
                        {
                            p.CloseMainWindow();
                        }
                    }
                    catch (Exception ex) { Loc.Note("AskRestart：枚举 dsh 进程", ex); }
                    finally { p.Dispose(); }
                }

                // 等它退干净
                for (int i = 0; i < 40; i++)
                {
                    bool alive = false;
                    foreach (var p in Process.GetProcesses())
                    {
                        try
                        {
                            string path = p.MainModule != null ? p.MainModule.FileName : null;
                            if (path != null && string.Equals(path, exe, StringComparison.OrdinalIgnoreCase)) alive = true;
                        }
                        catch (Exception ex) { Loc.Note("AskRestart：等待退出", ex); }
                        finally { p.Dispose(); }
                        if (alive) break;
                    }
                    if (!alive) break;
                    Application.DoEvents();
                    System.Threading.Thread.Sleep(250);
                }

                Process.Start(new ProcessStartInfo(exe) { UseShellExecute = true, WorkingDirectory = Path.GetDirectoryName(exe) });
                SetBusy(false, "已重启 dsh");
                LogLine("dsh 已重启。");
            }
            catch (Exception ex)
            {
                Message("自动重启失败", "请手动关掉 dsh 再打开。\n\n原因：" + ex.Message);
            }
        }

        private void Scrub()
        {
            if (!Preflight()) return;
            var r = MessageBox.Show(
                "把清洗补丁写进 dsh。\n\n" +
                "· 会先自动备份一份，出问题可以还原\n" +
                "· 可能需要一两分钟\n" +
                "· 做完要重启 dsh 才生效\n\n" +
                "现在开始吗？",
                "清洗宿主", MessageBoxButtons.OKCancel, MessageBoxIcon.Question);
            if (r != DialogResult.OK) return;
            RunSteps("清洗宿主", new List<string[]> { NodeJs(Loc.PurgeCli, "--apply") }, true);
        }

        private void Inject()
        {
            if (!Preflight()) return;
            RunSteps("注入破甲稿", new List<string[]> {
                NodeJs(Loc.ScrubCli, "prompt --import"),
                NodeJs(Loc.ScrubCli, "prompt --show"),
            }, true);
        }

        private void Status()
        {
            RunSteps("查看状态", new List<string[]> {
                NodeJs(Loc.PurgeCli, "--status"),
                NodeJs(Loc.ScrubCli, "verify"),
            });
        }

        private void RestoreDialog()
        {
            using (var dlg = new RestoreForm())
            {
                dlg.ShowDialog(this);
            }
        }

        private void Probe(bool verbose = false)
        {
            string node = Loc.Node();
            var roots = Loc.HostRoots();
            string host = roots.Count > 0 ? roots[0] : "未找到";
            string kit = File.Exists(Loc.ScrubCli) ? "已就位" : "缺失";
            // 底部只放短信息，长路径放到日志里，避免在窄栏里折行溢出。
            _where.Text = "宿主  " + Short(host, 26) + Environment.NewLine
                        + "工具包 " + kit;
            if (verbose)
            {
                ShowLog();
                LogLine("node     " + node);
                LogLine("宿主根   " + host);
                LogLine("profile  " + Loc.Purge);
                LogLine("工具包   " + Loc.ScrubCli);
            }
        }

        /// <summary>
        /// 启动时的自动探测。
        ///
        /// 要解决的问题：正常安装（注册表有记录）瞬间就找到；但注册表缺记录时
        /// Loc.HostRoots() 会走全盘搜索，在主线程上跑会让窗口卡住几秒到几分钟。
        ///
        /// 所以放到后台线程：
        ///   · 窗口立刻出现，状态栏先显示"正在找 dsh…"
        ///   · 找到了 → 状态栏更新成实际路径
        ///   · 找不到 → 明确告诉用户"这台电脑上没有 dsh，用不了"，而不是干等
        ///
        /// 目的就一个：双击就能用；真没有就当场说清楚，不让人猜。
        /// </summary>
        private void AutoLocate()
        {
            SetBusy(true, "正在找 dsh…");
            _where.Text = "正在找 dsh…";

            var worker = new System.ComponentModel.BackgroundWorker();
            worker.DoWork += (s, e) =>
            {
                var result = new AutoResult();

                // 1) 找 dsh
                result.Roots = Loc.HostRoots();
                if (result.Roots.Count == 0)
                {
                    e.Result = result;
                    return;
                }

                // 2) 顺手把插件装上（没装才装）。
                //
                // 放到这里是有意的：用户根本不需要知道"vvn 插件"这个东西。
                // vvn 自带了这个插件（kit\plugins\vvn），不联网、不需要 git，
                // 直接拷进 dsh 的 profile 就完事。以前要用户自己选模式才装，
                // 属于把内部细节推给了用户。
                if (!File.Exists(Loc.PurgeCli))
                {
                    try
                    {
                        var log = new List<string>();
                        Loc.InstallBundledPlugin("vvn", m => log.Add(m));
                        result.PluginInstalled = true;
                        result.PluginLog = string.Join("\n", log.ToArray());
                    }
                    catch (Exception ex)
                    {
                        result.PluginError = ex.Message;
                    }
                }

                e.Result = result;
            };
            worker.RunWorkerCompleted += (s, e) =>
            {
                var r = e.Result as AutoResult;
                if (r == null || r.Roots == null || r.Roots.Count == 0)
                {
                    SetBusy(false, "没找到 dsh");
                    _where.Text = "宿主  未找到" + Environment.NewLine + "工具包 " +
                                  (File.Exists(Loc.ScrubCli) ? "已就位" : "缺失");
                    ShowNoDsh();
                    return;
                }

                Probe();

                if (r.PluginInstalled)
                {
                    SetBusy(false, "就绪（已自动装好插件）");
                    LogLine("已自动装上 vvn 插件（vvn 自带的，不用联网）");
                    LogLine(r.PluginLog);
                }
                else if (!string.IsNullOrEmpty(r.PluginError))
                {
                    SetBusy(false, "就绪（插件没装上）");
                    LogLine("插件自动安装失败：" + r.PluginError);
                }
                else
                {
                    SetBusy(false, "就绪");
                }

                LogLine("找到 dsh：" + r.Roots[0]);
            };
            worker.RunWorkerAsync();
        }

        /// <summary>启动探测的结果。</summary>
        private class AutoResult
        {
            public List<string> Roots = new List<string>();
            public bool PluginInstalled;
            public string PluginLog = "";
            public string PluginError = "";
        }

        /// <summary>确实没有 dsh 时，把话说清楚，不要让人对着界面猜。</summary>
        private void ShowNoDsh()
        {
            using (var f = new ResultForm(ResultForm.FAIL, "vvn - 找不到 dsh", "这台电脑上没有 dsh",
                Loc.NoDshText()))
            {
                f.StartPosition = FormStartPosition.CenterParent;
                f.ShowDialog(this);
            }
        }

        /// <summary>"找不到 dsh" 的说明文案。提成静态方法，自检和界面共用一份。</summary>

        /// <summary>
        /// 快捷方式体检：桌面上的 vvn.lnk 是否指向本机这个 exe。
        ///
        /// 为什么需要：.lnk 存的是绝对路径，换台电脑拷过去就会指向一个
        /// 不存在的路径 —— 表现是"图标没了、双击打不开"。这里发现不对就
        /// 引导用户跑一次 setup.cmd 重建。
        /// </summary>
        private void CheckShortcut()
        {
            try
            {
                string desk = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
                if (string.IsNullOrEmpty(desk)) return;
                string lnk = Path.Combine(desk, "vvn.lnk");

                string self = System.Reflection.Assembly.GetExecutingAssembly().Location;
                bool needFix = false;

                if (!File.Exists(lnk))
                {
                    needFix = true;
                }
                else
                {
                    // 读 .lnk 的目标路径，比对是不是当前这个 exe
                    string target = Loc.ReadShortcutTarget(lnk);
                    if (!string.IsNullOrEmpty(target) &&
                        !string.Equals(Path.GetFullPath(target), Path.GetFullPath(self), StringComparison.OrdinalIgnoreCase))
                    {
                        needFix = true;
                    }
                }

                if (!needFix) return;

                var detail = new StringBuilder();
                detail.AppendLine("这个程序是从别的地方拷过来的，桌面上的图标没跟着走。");
                detail.AppendLine();
                detail.AppendLine("Windows 的快捷方式里存的是固定路径。换电脑以后，");
                detail.AppendLine("旧图标会指向一个不存在的地址 —— 看起来就是「图标没了」。");
                detail.AppendLine();
                detail.AppendLine("———————— 怎么修 ————————");
                detail.AppendLine();
                detail.AppendLine("在这个文件夹里找到  setup.cmd  ，双击它。");
                detail.AppendLine();
                detail.AppendLine("它会按这台电脑的真实路径重新建一个桌面图标。");
                detail.AppendLine("跑一次就行。");
                detail.AppendLine();
                detail.AppendLine("当前位置：");
                detail.AppendLine("  " + Loc.AppDir());

                string setup = Path.Combine(Loc.AppDir(), "setup.cmd");
                if (!File.Exists(setup))
                {
                    detail.AppendLine();
                    detail.AppendLine("找不到 setup.cmd。可以自己右键 vvn.exe → 发送到 → 桌面快捷方式。");
                }

                using (var f = new ResultForm(ResultForm.WARN, "vvn - 桌面图标", "桌面图标需要重建一次", detail.ToString()))
                {
                    f.StartPosition = FormStartPosition.CenterParent;
                    f.ShowDialog(this);
                }
            }
            catch (Exception ex) { Loc.Note("CheckShortcut：读快捷方式", ex); }
        }


        private static string Short(string s, int max)
        {
            if (string.IsNullOrEmpty(s)) return "";
            if (s.Length <= max) return s;
            string tail = s.Substring(s.Length - max + 1);
            return "…" + tail;
        }
    }

    internal class ResultForm : Form
    {
        public const int OK = 0, FAIL = 1, WARN = 2;

        public ResultForm(int kind, string title, string headline, string detail)
        {
            Text = title;
            Size = new Size(560, 420);
            StartPosition = FormStartPosition.CenterParent;
            BackColor = Color.FromArgb(24, 26, 31);
            ForeColor = Color.FromArgb(230, 235, 242);
            Font = new Font("Microsoft YaHei UI", 10F);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;

            Color tone = kind == OK ? Color.FromArgb(76, 175, 110)
                       : kind == FAIL ? Color.FromArgb(200, 84, 78)
                       : Color.FromArgb(200, 145, 62);

            // 顶部色条
            var bar = new Panel { Dock = DockStyle.Top, Height = 6, BackColor = tone };

            // 大图标
            var icon = new BigIcon
            {
                Dock = DockStyle.Top,
                Height = 132,
                Kind = kind,
                Tone = tone,
            };

            var head = new Label
            {
                Dock = DockStyle.Top,
                Height = 52,
                Text = headline,
                TextAlign = ContentAlignment.MiddleCenter,
                Font = new Font("Microsoft YaHei UI", 15F, FontStyle.Bold),
                ForeColor = tone,
            };

            var body = new TextBox
            {
                Dock = DockStyle.Fill,
                Multiline = true,
                ReadOnly = true,
                ScrollBars = ScrollBars.Vertical,
                BackColor = Color.FromArgb(18, 20, 24),
                ForeColor = Color.FromArgb(200, 206, 214),
                Font = new Font("Microsoft YaHei UI", 9.5F),
                BorderStyle = BorderStyle.None,
                Text = detail,
            };

            var wrap = new Panel { Dock = DockStyle.Fill, Padding = new Padding(20, 8, 20, 8) };
            wrap.Controls.Add(body);

            var foot = new Panel { Dock = DockStyle.Bottom, Height = 62, Padding = new Padding(20, 12, 20, 14) };
            var close = new Button
            {
                Text = "知道了",
                Dock = DockStyle.Right,
                Width = 132,
                FlatStyle = FlatStyle.Flat,
                BackColor = tone,
                ForeColor = Color.White,
                Font = new Font("Microsoft YaHei UI", 10.5F, FontStyle.Bold),
                Cursor = Cursors.Hand,
            };
            close.FlatAppearance.BorderSize = 0;
            close.Click += (s, e) => Close();
            foot.Controls.Add(close);

            Controls.Add(wrap);
            Controls.Add(foot);
            Controls.Add(head);
            Controls.Add(icon);
            Controls.Add(bar);

            AcceptButton = close;
            CancelButton = close;
        }
    }

    /// <summary>手绘的大号对勾 / 叉 / 叹号，避免依赖图标字体。</summary>
    internal class BigIcon : Control
    {
        public int Kind = ResultForm.OK;
        public Color Tone = Color.FromArgb(76, 175, 110);

        public BigIcon()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer, true);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;

            int size = Math.Min(Width, Height) - 24;
            int cx = Width / 2, cy = Height / 2;
            var circle = new Rectangle(cx - size / 2, cy - size / 2, size, size);

            using (var fill = new SolidBrush(Color.FromArgb(38, Tone)))
                g.FillEllipse(fill, circle);
            using (var pen = new Pen(Tone, Math.Max(2.5f, size * 0.055f)))
                g.DrawEllipse(pen, circle);

            using (var pen = new Pen(Tone, Math.Max(4f, size * 0.1f)))
            {
                pen.StartCap = System.Drawing.Drawing2D.LineCap.Round;
                pen.EndCap = System.Drawing.Drawing2D.LineCap.Round;
                float r = size / 2f;
                if (Kind == ResultForm.OK)
                {
                    // 对勾
                    g.DrawLines(pen, new[]
                    {
                        new PointF(cx - r * 0.46f, cy + r * 0.04f),
                        new PointF(cx - r * 0.12f, cy + r * 0.38f),
                        new PointF(cx + r * 0.50f, cy - r * 0.36f),
                    });
                }
                else if (Kind == ResultForm.FAIL)
                {
                    // 叉
                    g.DrawLine(pen, cx - r * 0.36f, cy - r * 0.36f, cx + r * 0.36f, cy + r * 0.36f);
                    g.DrawLine(pen, cx + r * 0.36f, cy - r * 0.36f, cx - r * 0.36f, cy + r * 0.36f);
                }
                else
                {
                    // 叹号
                    g.DrawLine(pen, cx, cy - r * 0.42f, cx, cy + r * 0.14f);
                    using (var b = new SolidBrush(Tone))
                        g.FillEllipse(b, cx - pen.Width * 0.5f, cy + r * 0.30f, pen.Width, pen.Width);
                }
            }
        }
    }

internal class RestoreForm : Form
    {
        private readonly ListBox _list = new ListBox();
        private readonly CheckBox _dry = new CheckBox();
        private readonly Label _hint = new Label();
        private readonly List<string> _ids = new List<string>();

        public RestoreForm()
        {
            Text = "还原宿主文件";
            Size = new Size(680, 460);
            StartPosition = FormStartPosition.CenterParent;
            BackColor = Color.FromArgb(24, 26, 31);
            ForeColor = Color.FromArgb(230, 235, 242);
            Font = new Font("Microsoft YaHei UI", 9F);

            _hint.Text = "选一份快照（每次清洗前自动生成）。" + Environment.NewLine +
                         "勾上「试运行」只看会改什么，不动文件。";
            _hint.Dock = DockStyle.Top; _hint.Height = 46;
            _hint.Padding = new Padding(12, 10, 12, 0);
            _hint.ForeColor = Color.FromArgb(139, 149, 163);

            _list.Dock = DockStyle.Fill;
            _list.BackColor = Color.FromArgb(18, 20, 24);
            _list.ForeColor = Color.FromArgb(230, 235, 242);
            _list.Font = new Font("Consolas", 9.5F);
            _list.BorderStyle = BorderStyle.None;
            _list.IntegralHeight = false;

            var bar = new Panel { Dock = DockStyle.Bottom, Height = 54, Padding = new Padding(12, 8, 12, 10) };
            var go = new Button
            {
                Text = "还原", Dock = DockStyle.Right, Width = 110,
                FlatStyle = FlatStyle.Flat, BackColor = Color.FromArgb(47, 109, 246),
                ForeColor = Color.White, Font = new Font("Microsoft YaHei UI", 9.5F, FontStyle.Bold),
            };
            go.FlatAppearance.BorderSize = 0;
            _dry.Text = "试运行"; _dry.Dock = DockStyle.Right; _dry.Width = 90;
            _dry.ForeColor = Color.FromArgb(230, 235, 242);
            go.Click += (s, e) => DoRestore();
            bar.Controls.Add(go);
            bar.Controls.Add(_dry);

            var wrap = new Panel { Dock = DockStyle.Fill, Padding = new Padding(12, 0, 12, 0) };
            wrap.Controls.Add(_list);

            Controls.Add(wrap);
            Controls.Add(bar);
            Controls.Add(_hint);
            Load += (s, e) => LoadSnaps();
        }

        /// <summary>一份快照的摘要（列表用）。</summary>
        internal class SnapInfo
        {
            public string Id;
            public string Label;
            public long Files;
            public long Bytes;
            public string Broken;
        }

        /// <summary>
        /// 读出快照列表。
        ///
        /// 走 vvn-restore.mjs 拿 JSON，再用标准解析器读 —— 不再自己 IndexOf 抠字符串：
        /// manifest 里的路径是 JSON 转义的（"C:\\\\deepseek\\\\..."），手写解析会在
        /// 转义和嵌套上读错。
        ///
        /// 提成静态方法是为了能单独调用（--test-restore 走的就是这里）。
        /// </summary>
        public static List<SnapInfo> LoadSnapshotList()
        {
            var result = new List<SnapInfo>();

            string helper = Path.Combine(Loc.AppDir(), "vvn-restore.mjs");
            if (!File.Exists(helper)) return result;

            string output = RunAndCapture(Loc.Node(), "\"" + helper + "\" list", null, 20000);
            foreach (var s in Json.ListObjects(output, "snapshots"))
            {
                result.Add(new SnapInfo
                {
                    Id = Json.Str(s, "id"),
                    Label = Json.Str(s, "label"),
                    Files = Json.Num(s, "files"),
                    Bytes = Json.Num(s, "bytes"),
                    Broken = Json.Str(s, "broken"),
                });
            }
            return result;
        }

        private void LoadSnaps()
        {
            _list.Items.Clear();
            _ids.Clear();

            string helper = Path.Combine(Loc.AppDir(), "vvn-restore.mjs");
            if (!File.Exists(helper))
            {
                _hint.Text = "找不到 vvn-restore.mjs（应该和 vvn.exe 放在一起）";
                return;
            }

            var snaps = LoadSnapshotList();
            if (snaps.Count == 0)
            {
                _hint.Text = "还没有快照（第一次清洗时会自动生成）。";
                return;
            }

            foreach (var s in snaps)
            {
                string line = string.Format("{0}   {1} 文件   {2:F1} MB   {3}{4}",
                    s.Id, s.Files, s.Bytes / 1048576.0, s.Label,
                    string.IsNullOrEmpty(s.Broken) ? "" : "  (损坏)");
                _ids.Add(s.Id);
                _list.Items.Add(line);
            }
            _list.SelectedIndex = 0;
        }

        private void DoRestore()
        {
            int idx = _list.SelectedIndex;
            if (idx < 0 || idx >= _ids.Count) { MessageBox.Show("先选一份快照。"); return; }
            string id = _ids[idx];
            bool dry = _dry.Checked;

            if (!dry)
            {
                var r = MessageBox.Show(
                    "用快照覆盖当前 dsh 本体文件：\n\n" + id + "\n\n这一步会改动 dsh 程序文件。继续吗？",
                    "确认还原", MessageBoxButtons.OKCancel, MessageBoxIcon.Warning);
                if (r != DialogResult.OK) return;
            }

            string helper = Path.Combine(Loc.AppDir(), "vvn-restore.mjs");
            string snapJs = Path.Combine(Loc.Purge, "lib", "snapshot.js");
            string args = "\"" + helper + "\" restore \"" + snapJs + "\" \"" + id + "\"" + (dry ? " --dry" : "");

            this.Enabled = false;
            string output = RunAndCapture(Loc.Node(), args, null, 120000);
            this.Enabled = true;

            // 输出是 JSON，用标准解析器读；失败时把原文给用户看。
            var doc = Json.Parse(output);
            string msg;
            if (doc == null)
            {
                msg = "命令没有返回可解析的结果。\n\n原始输出：\n" + Clip(output, 1500);
            }
            else if (!Json.Bool(doc, "ok"))
            {
                msg = "还原没有完成。\n\n原因：" + Json.Str(doc, "error");
            }
            else if (Json.Bool(doc, "dry"))
            {
                msg = "试运行：会用这份快照还原，但没有改动任何文件。\n\n" + id +
                      "\n\n去掉「试运行」勾选就会真的还原。";
            }
            else
            {
                int restored = Json.ListObjects(output, "restored").Count;
                int skipped = Json.ListObjects(output, "skipped").Count;
                int missing = Json.ListObjects(output, "missing").Count;
                msg = "已还原 " + restored + " 个文件。\n" +
                      "跳过 " + skipped + "，缺失 " + missing + "。";
                if (skipped > 0) msg += "\n\n有跳过的项，说明快照里的文件校验没过（可能被改过）。";
                msg += "\n\n重启 dsh 生效。";
            }
            MessageBox.Show(msg, "还原结果", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }

        /// <summary>同步跑一个命令并把输出抓回来（给对话框用，窗口本来就是模态的）。</summary>
        private static string RunAndCapture(string exe, string args, Dictionary<string, string> env, int timeoutMs)
        {
            try
            {
                var psi = new ProcessStartInfo(exe, args)
                {
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    StandardOutputEncoding = Encoding.UTF8,
                    StandardErrorEncoding = Encoding.UTF8,
                    WorkingDirectory = Loc.AppDir(),
                };
                psi.EnvironmentVariables["DSH_SURFACE"] = "desktop";
                psi.EnvironmentVariables["DSH_HOME"] = Loc.Home;
                if (env != null) foreach (var kv in env) psi.EnvironmentVariables[kv.Key] = kv.Value;

                using (var p = Process.Start(psi))
                {
                    string stdout = p.StandardOutput.ReadToEnd();
                    string stderr = p.StandardError.ReadToEnd();
                    if (!p.WaitForExit(timeoutMs))
                    {
                        try { p.Kill(); } catch (Exception ex) { Loc.Note("超时清理：结束进程", ex); }
                        return "{\"ok\":false,\"error\":\"命令超时未返回\"}";
                    }
                    return string.IsNullOrWhiteSpace(stdout) ? stderr : stdout;
                }
            }
            catch (Exception ex)
            {
                return "{\"ok\":false,\"error\":" + Json.Quote(ex.Message) + "}";
            }
        }

        private static string Clip(string s, int max)
        {
            if (string.IsNullOrEmpty(s)) return "";
            return s.Length <= max ? s : s.Substring(0, max) + "\n…（后面略）";
        }
    }

    /// <summary>
    /// JSON 读写小助手。
    ///
    /// 解析走 .NET 自带的 JavaScriptSerializer —— 不再手撸字符串裁剪。
    /// 之前那版只找引号就截断，遇到 manifest 里 "C:\\\\deepseek\\\\..." 这种
    /// 转义路径或嵌套数组就会读错。
    /// </summary>
    internal static class Json
    {
        private static System.Web.Script.Serialization.JavaScriptSerializer Ser()
        {
            var s = new System.Web.Script.Serialization.JavaScriptSerializer();
            s.MaxJsonLength = int.MaxValue;
            return s;
        }

        public static Dictionary<string, object> Parse(string text)
        {
            if (string.IsNullOrWhiteSpace(text)) return null;
            // 只取第一行 JSON —— 脚本可能还有别的输出混在前面
            foreach (var line in text.Split('\n'))
            {
                string t = line.Trim();
                if (t.Length < 2 || t[0] != '{') continue;
                try { return Ser().Deserialize<Dictionary<string, object>>(t); }
                catch { /* 这一行不是 JSON，继续试下一行 —— 这里静默是有意的 */ }
            }
            try { return Ser().Deserialize<Dictionary<string, object>>(text.Trim()); }
            catch { return null; }
        }

        public static string Str(Dictionary<string, object> d, string key)
        {
            if (d == null || !d.ContainsKey(key) || d[key] == null) return "";
            return Convert.ToString(d[key]);
        }

        public static long Num(Dictionary<string, object> d, string key)
        {
            if (d == null || !d.ContainsKey(key) || d[key] == null) return 0;
            try { return Convert.ToInt64(d[key]); } catch { return 0; }
        }

        public static bool Bool(Dictionary<string, object> d, string key)
        {
            if (d == null || !d.ContainsKey(key) || d[key] == null) return false;
            try { return Convert.ToBoolean(d[key]); } catch { return false; }
        }

        /// <summary>把 d[key] 当对象数组取出来（JavaScriptSerializer 给的是 ArrayList）。</summary>
        public static List<Dictionary<string, object>> ListObjects(string text, string key)
        {
            var result = new List<Dictionary<string, object>>();
            var doc = Parse(text);
            if (doc == null || !doc.ContainsKey(key)) return result;
            var raw = doc[key] as System.Collections.ArrayList;
            if (raw == null) return result;
            foreach (var item in raw)
            {
                var dd = item as Dictionary<string, object>;
                if (dd != null) result.Add(dd);
            }
            return result;
        }

        /// <summary>把一个字符串转成安全的 JSON 字面量（含引号）。</summary>
        public static string Quote(string s)
        {
            return Ser().Serialize(s ?? "");
        }
    }

    internal static class Entry
    {
        [System.Runtime.InteropServices.DllImport("kernel32.dll")]
        private static extern bool AttachConsole(int dwProcessId);

        // 让内嵌 WebBrowser 用 IE11 内核：否则它是 IE7 兼容模式，CSS 全塌。
        // 写当前用户注册表，不需要管理员权限；已存在就覆盖成 IE11。
        private static void EnableModernWebBrowser(string exeName)
        {
            try
            {
                const string path = @"Software\Microsoft\Internet Explorer\Main\FeatureControl\FEATURE_BROWSER_EMULATION";
                using (var k = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(path))
                {
                    if (k != null) k.SetValue(exeName, 11001, Microsoft.Win32.RegistryValueKind.DWord);
                }
            }
            catch (Exception ex) { Loc.Note("EnableModernWebBrowser：写注册表", ex); }
        }

        [STAThread]
        private static void Main(string[] args)
        {
            EnableModernWebBrowser(Path.GetFileName(Application.ExecutablePath));

            // --test-restore：把还原对话框的读取逻辑跑一遍，把结果写成文本。
            // 给自动化回归用：不开窗口，直接验证快照列表能不能读出来。
            if (args != null && args.Length > 0 && args[0] == "--test-restore")
            {
                AttachConsole(-1);
                var sb = new StringBuilder();
                try
                {
                    var snaps = RestoreForm.LoadSnapshotList();
                    sb.AppendLine("count=" + snaps.Count);
                    foreach (var s in snaps)
                    {
                        sb.AppendLine(s.Id + " | " + s.Files + " files | " + s.Bytes + " B | " + s.Label);
                    }
                    sb.AppendLine(snaps.Count > 0 ? "OK" : "EMPTY");
                }
                catch (Exception ex)
                {
                    sb.AppendLine("FAILED: " + ex);
                }
                try { Console.WriteLine(sb.ToString()); } catch { /* 无控制台时正常 —— 报告已写文件 */ }
                try
                {
                    File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "vvn-restore-test.txt"),
                        sb.ToString(), new UTF8Encoding(false));
                }
                catch (Exception ex) { Loc.Note("写 restore 测试报告", ex); }
                Environment.Exit(0);
                return;
            }

            // --install-plugin：离线把 vvn 自带的 vvn 装进 profile。
            // 给"远程指导别人"用：让对方在这个文件夹开个命令行跑一次即可。
            if (args != null && args.Length > 0 && args[0] == "--install-plugin")
            {
                AttachConsole(-1);
                var sb = new StringBuilder();
                try
                {
                    Loc.InstallBundledPlugin("vvn", m => { sb.AppendLine(m); try { Console.WriteLine(m); } catch { /* 无控制台，只写文件 */ } });
                    sb.AppendLine("OK: plugin installed");
                }
                catch (Exception ex)
                {
                    sb.AppendLine("FAILED: " + ex.Message);
                    try { Console.WriteLine("FAILED: " + ex.Message); } catch { /* 无控制台 */ }
                }
                try { File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "vvn-install.txt"), sb.ToString(), new UTF8Encoding(false)); } catch (Exception ex) { Loc.Note("写 install 报告", ex); }
                Environment.Exit(0);
                return;
            }

            // --selftest：不需要真的缺 dsh，也能验证各条分支的输出。给回归用。
            if (args != null && args.Length > 0 && args[0] == "--selftest")
            {
                AttachConsole(-1);
                var sb = new StringBuilder();
                sb.AppendLine("vvn selftest");
                sb.AppendLine("============");
                sb.AppendLine();

                sb.AppendLine("[1] 启动探测链");
                var roots = Loc.HostRoots();
                sb.AppendLine("    HostRoots 返回 " + roots.Count + " 个");
                foreach (var r in roots) sb.AppendLine("      " + r);
                sb.AppendLine("    结果：" + (roots.Count > 0 ? "会显示「就绪」" : "会弹「找不到 dsh」"));
                sb.AppendLine();

                sb.AppendLine("[2] 找不到时的提示文案（不依赖真实环境，直接生成）");
                string noDsh = Loc.NoDshText();
                foreach (var line in noDsh.Split('\n'))
                    sb.AppendLine("    " + line.TrimEnd());
                sb.AppendLine();

                sb.AppendLine("[3] 判据自检：哪些目录会被误认成 dsh 安装根");
                string[] decoys = {
                    @"C:\Program Files\WindowsApps\Microsoft.SkypeApp\Skype",
                    @"D:\work\WorkBuddyAI",
                    @"D:\BaiduNetdisk\module\BrowserEngine",
                };
                foreach (var dd in decoys)
                {
                    bool hit = File.Exists(Path.Combine(dd, @"resources\app.asar"))
                            && (File.Exists(Path.Combine(dd, "DeepSeek Harness.exe"))
                                || Directory.Exists(Path.Combine(dd, @"resources\runtime\primary-runtime")));
                    sb.AppendLine("    " + (hit ? "✗ 会误判" : "✓ 正确排除") + "  " + dd);
                }

                try { Console.WriteLine(sb.ToString()); } catch { }
                try { File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "vvn-selftest.txt"), sb.ToString(), new UTF8Encoding(false)); }
                catch (Exception ex) { Loc.Note("写 selftest 报告", ex); }
                Environment.Exit(0);
                return;
            }

            // --find：忽略注册表/进程，直接全盘搜 dsh 安装根。
            // 前面三层都找不到时用它。也给远程排查用：让对方跑一次看结果。
            if (args != null && args.Length > 0 && args[0] == "--find")
            {
                AttachConsole(-1);
                var sb = new StringBuilder();
                sb.AppendLine("vvn deep search");
                sb.AppendLine("===============");
                sb.AppendLine();

                var sw = System.Diagnostics.Stopwatch.StartNew();
                var hits = Loc.DeepSearch(
                    s => { sb.AppendLine("  " + s); try { Console.WriteLine(s); } catch { } },
                    () => false);
                sw.Stop();

                sb.AppendLine();
                sb.AppendLine("found " + hits.Count + " in " + Math.Round(sw.Elapsed.TotalSeconds, 1) + "s");
                foreach (var h in hits)
                {
                    sb.AppendLine();
                    sb.AppendLine(h);
                    sb.AppendLine("  resources\\app.asar : " + File.Exists(Path.Combine(h, @"resources\app.asar")));
                    sb.AppendLine("  resources\\app      : " + Directory.Exists(Path.Combine(h, @"resources\app")));
                    sb.AppendLine("  @deepseek-ai 宿主   : " + Directory.Exists(Path.Combine(h, @"resources\app\dsh\node_modules\@deepseek-ai")));
                }

                try { File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "vvn-find.txt"), sb.ToString(), new UTF8Encoding(false)); } catch (Exception ex) { Loc.Note("写 find 报告", ex); }
                Environment.Exit(0);
                return;
            }

            // --check：把自检结果打出来并退出，不弹窗。
            // 给"远程帮别人排查"用：让对方跑一次，把输出发过来即可。
            if (args != null && args.Length > 0 && args[0] == "--check")
            {
                string report = CheckReport();
                // winexe 没有自己的控制台，直接设 OutputEncoding 会抛 IOException；
                // 所以先试着附加父进程的控制台，失败就只写文件。
                try
                {
                    AttachConsole(-1);
                    Console.OutputEncoding = Encoding.UTF8;
                    Console.WriteLine(report);
                }
                catch { /* 没有控制台 —— 预期内，报告会写文件 */ }

                try
                {
                    string outFile = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "vvn-check.txt");
                    File.WriteAllText(outFile, report, new UTF8Encoding(false));
                    try { Console.WriteLine("(also written to " + outFile + ")"); } catch { /* 无控制台 */ }
                }
                catch (Exception ex) { Loc.Note("Main：附加控制台", ex); }

                Environment.Exit(0);
                return;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            try { Application.Run(new MainForm()); }
            catch (Exception ex)
            {
                MessageBox.Show(ex.ToString(), "vvn 启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        /// <summary>自检的纯文本版本，不依赖窗口。</summary>
        private static string CheckReport()
        {
            var sb = new StringBuilder();
            sb.AppendLine("vvn self check");
            sb.AppendLine("==============");
            sb.AppendLine();

            sb.AppendLine("program dir : " + Loc.AppDir());
            string node = Loc.Node();
            sb.AppendLine("node        : " + node + (File.Exists(node) ? "  [ok]" : "  [MISSING]"));
            sb.AppendLine();

            var installs = Loc.InstallRoots();
            sb.AppendLine("dsh install : " + (installs.Count > 0 ? installs.Count + " found" : "NONE FOUND"));
            foreach (var r in installs) sb.AppendLine("              " + r);
            sb.AppendLine();

            var hosts = Loc.HostRoots();
            sb.AppendLine("host roots  : " + hosts.Count + " found");
            foreach (var h in hosts) sb.AppendLine("              " + h);
            string asarPath;
            if (Loc.IsAsarPacked(out asarPath))
                sb.AppendLine("              [NOTE] dsh is still packed: " + asarPath);
            sb.AppendLine();

            sb.AppendLine("vvn   : " + Loc.PurgeCli + (File.Exists(Loc.PurgeCli) ? "  [ok]" : "  [MISSING]"));
            sb.AppendLine("tool kit    : " + Loc.ScrubCli + (File.Exists(Loc.ScrubCli) ? "  [ok]" : "  [MISSING]"));
            sb.AppendLine("kit folder  : " + Path.Combine(Loc.AppDir(), "kit") +
                          (Directory.Exists(Path.Combine(Loc.AppDir(), "kit")) ? "  [exists]" : "  [MISSING]"));
            sb.AppendLine();

            string desk = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            string lnk = Path.Combine(desk, "vvn.lnk");
            string self = System.Reflection.Assembly.GetExecutingAssembly().Location;
            sb.AppendLine("desktop lnk : " + lnk + (File.Exists(lnk) ? "  [exists]" : "  [MISSING]"));
            if (File.Exists(lnk))
            {
                string target = Loc.ReadShortcutTarget(lnk);
                sb.AppendLine("lnk target  : " + (target ?? "(unreadable)"));
                sb.AppendLine("points here : " +
                    (string.Equals(target, self, StringComparison.OrdinalIgnoreCase) ? "YES" : "NO - run setup.cmd"));
            }
            sb.AppendLine();
            sb.AppendLine("self        : " + self);

            // 面板能不能起来 —— "请求失败"最常见的两个原因就在这里
            sb.AppendLine();
            sb.AppendLine("panel port  : 43190" + (Loc.PortInUse(43190) ? "  [in use]" : "  [free]"));
            bool panelOk = false;
            try
            {
                var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:43190/scrub/api/ping");
                req.Timeout = 2000; req.Proxy = null;
                using (var resp = (HttpWebResponse)req.GetResponse())
                    panelOk = resp.StatusCode == HttpStatusCode.OK;
            }
            catch (Exception ex) { Loc.Note("自检：探面板", ex); }
            sb.AppendLine("panel ping  : " + (panelOk ? "OK" : "no response (panel not running — 这是正常的，主窗口会自己拉起来)"));

            var notes = Loc.Notes();
            sb.AppendLine();
            sb.AppendLine("notes       : " + notes.Length + " 条（点界面上的「诊断记录」看详情）");
            for (int i = Math.Max(0, notes.Length - 5); i < notes.Length; i++)
                sb.AppendLine("              " + notes[i]);

            return sb.ToString();
        }
    }
}
