//! Retro Messenger 桌面入口：模块组织与 Tauri 应用装配。
//! 主题模块见同目录文件；本文件只保留模块声明与 run()。

mod chat;
mod projects;
mod pty;
mod terminal_exec;
mod terminal_files;
mod types;

use chat::{
    bootstrap, create_terminal_contact, execute_terminal, generate_reply, get_conversation,
    mark_read, rename_terminal_contact, send_message, set_presence, ChatStore,
};
use projects::{
    open_project_folder_in_onecommander, open_project_store_file, parse_project_folder,
    project_store_path, read_project_store, spawn_project_store_watcher, write_project_store,
};
use std::sync::Mutex;
use pty::{pty_close, pty_open, pty_resize, pty_write, PtyState};
use terminal_files::{
    export_terminal_image, open_terminal_file, read_terminal_image, save_terminal_image,
    stat_terminal_image,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    configure_wslg_input_backend();

    tauri::Builder::default()
        .setup(|app| {
            spawn_project_store_watcher(app.handle().clone());

            #[cfg(target_os = "linux")]
            {
                use tauri::Manager;
                use webkit2gtk::{InputMethodContextExt, WebViewExt};

                // Wry 0.55 disables WebKitGTK preedit by default. Re-enable it
                // so Fcitx/IBus can deliver proper DOM composition events and
                // render an in-place candidate string in input/textarea fields.
                if let Some(main_webview) = app.get_webview_window("main") {
                    main_webview.with_webview(|platform_webview| {
                        if let Some(input_context) = platform_webview.inner().input_method_context()
                        {
                            input_context.set_enable_preedit(true);
                        }
                    })?;
                }
            }

            Ok(())
        })
        .manage(Mutex::new(ChatStore::demo()))
        .manage(PtyState::default())
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            get_conversation,
            send_message,
            generate_reply,
            create_terminal_contact,
            rename_terminal_contact,
            execute_terminal,
            parse_project_folder,
            open_project_folder_in_onecommander,
            project_store_path,
            read_project_store,
            write_project_store,
            open_project_store_file,
            pty_open,
            pty_write,
            pty_resize,
            pty_close,
            save_terminal_image,
            read_terminal_image,
            stat_terminal_image,
            export_terminal_image,
            open_terminal_file,
            mark_read,
            set_presence
        ])
        .run(tauri::generate_context!())
        .expect("error while running Retro Messenger");
}


#[cfg(test)]
pub(crate) mod tests {
    use crate::chat::*;
use crate::projects::*;
use crate::pty::*;
use crate::terminal_exec::*;
use crate::terminal_files::*;
use crate::types::*;
    use std::path::{Path, PathBuf};

    #[test]
    fn send_message_trims_and_validates_input() {
        let mut store = ChatStore::demo();
        let message = store
            .send_message("ache", "  你好，晚上聊！\r\n  ")
            .expect("valid message should be accepted");

        assert_eq!(message.text, "你好，晚上聊！");
        assert!(message.outgoing);
        assert_eq!(store.active_contact_id, "ache");
        assert_eq!(store.contact("ache").unwrap().last_message, message.text);
        assert!(store.send_message("ache", " \n\t ").is_err());
        assert!(store
            .send_message("ache", &"好".repeat(MAX_MESSAGE_CHARS + 1))
            .is_err());
        assert!(store.send_message("missing", "hello").is_err());
    }

    #[test]
    fn generated_reply_is_contextual_and_deterministic() {
        let contact = ChatStore::demo().contact("ache").unwrap().clone();
        assert_eq!(
            contextual_reply(&contact, "文件已经发给你了"),
            contextual_reply(&contact, "文件已经发给你了")
        );
        assert!(contextual_reply(&contact, "文件已经发给你了").contains("收到"));

        let mut store = ChatStore::demo();
        store.send_message("ache", "明天几点开会？").unwrap();
        let reply = store.generate_reply("ache").unwrap();
        assert!(!reply.outgoing);
        assert!(reply.read);
        assert!(reply.text.contains("准时"));
        assert_eq!(store.contact("ache").unwrap().unread_count, 0);

        store.mark_read("linxia").unwrap();
        let background_reply = store.generate_reply("ache").unwrap();
        assert!(!background_reply.read);
        assert_eq!(store.contact("ache").unwrap().unread_count, 1);
    }

    #[test]
    fn terminal_executes_commands_and_records_the_session() {
        let mut store = ChatStore::demo();
        let execution = store.execute_terminal("echo retro-terminal").unwrap();

        assert!(execution.success);
        assert_eq!(execution.exit_code, Some(0));
        assert!(execution.output_message.text.contains("retro-terminal"));
        assert_eq!(store.active_contact_id, TERMINAL_ID);
        assert_eq!(
            store.contact(TERMINAL_ID).unwrap().last_message,
            execution.output_message.text
        );
        assert!(store.execute_terminal(" \n ").is_err());
    }

    #[test]
    fn terminal_contacts_are_independent_and_numbered() {
        let mut store = ChatStore::demo();
        let second = store.create_terminal_contact();
        let third = store.create_terminal_contact();

        assert_eq!(second.id, "terminal-2");
        assert_eq!(second.display_name, "WSL 终端 2");
        assert_eq!(third.id, "terminal-3");
        assert_eq!(third.group, "工具");
        assert_eq!(store.active_contact_id, third.id);
        assert!(store.conversation(&second.id).unwrap().is_empty());
        assert_eq!(store.snapshot().contacts.len(), 8);

        let renamed = store
            .rename_terminal_contact(&second.id, "  项目终端  ")
            .unwrap();
        assert_eq!(renamed.display_name, "项目终端");
        assert_eq!(store.contact(&second.id).unwrap().display_name, "项目终端");
        assert!(store.rename_terminal_contact("ache", "错误名称").is_err());
        assert!(store.rename_terminal_contact(&third.id, "   ").is_err());
        assert!(store
            .rename_terminal_contact(&third.id, &"终".repeat(25))
            .is_err());
    }

    #[test]
    fn project_folder_paths_are_normalized_for_windows_and_wsl() {
        let drive =
            parse_project_folder_path(r#"  d:/Workspace//中文 项目/.\packages\..\app  "#).unwrap();

        assert_eq!(drive.location.name, "app");
        assert_eq!(drive.location.path, r#"D:\Workspace\中文 项目\app"#);
        assert_eq!(drive.wsl_path, "/mnt/d/Workspace/中文 项目/app");
        assert_eq!(drive.source, ProjectFolderSource::WindowsDrive);

        let root = parse_project_folder_path(r#"c:\"#).unwrap();
        assert_eq!(root.location.name, "C 盘");
        assert_eq!(root.location.path, r#"C:\"#);
        assert_eq!(root.wsl_path, "/mnt/c");

        let unc = parse_project_folder_path(
            r#"\\wsl.localhost\Ubuntu\home\developer\project\CNV_polidy_identify"#,
        )
        .unwrap();
        assert_eq!(unc.location.name, "CNV_polidy_identify");
        assert_eq!(
            unc.location.path,
            r#"\\wsl.localhost\Ubuntu\home\developer\project\CNV_polidy_identify"#
        );
        assert_eq!(unc.wsl_path, "/home/developer/project/CNV_polidy_identify");
        assert_eq!(unc.wsl_distribution.as_deref(), Some("Ubuntu"));
        assert_eq!(unc.source, ProjectFolderSource::WslUnc);

        let legacy_unc =
            parse_project_folder_path(r#"\\wsl$\Ubuntu\home\developer\project"#).unwrap();
        assert_eq!(
            legacy_unc.location.path,
            r#"\\wsl$\Ubuntu\home\developer\project"#
        );
        assert_eq!(legacy_unc.wsl_path, "/home/developer/project");

        for input in [
            r#"home\developer\project\CNV_polidy_identify"#,
            "home/developer/project/CNV_polidy_identify",
            "/home/developer/project/CNV_polidy_identify",
        ] {
            let fallback = parse_project_folder_path(input).unwrap();
            assert_eq!(
                fallback.location.path,
                "/home/developer/project/CNV_polidy_identify"
            );
            assert_eq!(fallback.wsl_path, fallback.location.path);
            assert_eq!(fallback.source, ProjectFolderSource::Wsl);
        }
    }

    #[test]
    fn wsl_home_paths_are_resolved_before_they_are_cached() {
        let resolved =
            parse_project_folder_path_with_wsl_home(r#"  ~/project/win_edge/./download  "#, || {
                Ok("/home/developer".into())
            })
            .unwrap();

        assert_eq!(resolved.location.name, "download");
        assert_eq!(
            resolved.location.path,
            "/home/developer/project/win_edge/download"
        );
        assert_eq!(resolved.wsl_path, resolved.location.path);
        assert_eq!(resolved.source, ProjectFolderSource::Wsl);

        let home =
            parse_project_folder_path_with_wsl_home("~", || Ok("/home/中文 用户".into())).unwrap();
        assert_eq!(home.location.path, "/home/中文 用户");
        assert_eq!(home.location.name, "中文 用户");

        let legacy =
            parse_project_folder_path_with_wsl_home("/~/project/win_edge/download", || {
                Ok("/home/developer".into())
            })
            .unwrap();
        assert_eq!(legacy.wsl_path, "/home/developer/project/win_edge/download");

        assert!(parse_project_folder_path("~/project").is_err());
        assert!(parse_project_folder_path_with_wsl_home("~/../etc", || {
            panic!("an invalid relative path must not invoke WSL")
        })
        .is_err());
        assert!(
            parse_project_folder_path_with_wsl_home("~other/project", || {
                panic!("unsupported home syntax must not invoke WSL")
            })
            .is_err()
        );
    }

    #[test]
    fn project_folder_paths_reject_ambiguous_or_unsafe_input() {
        for invalid in [
            "",
            r#"C:workspace"#,
            r#"1:\workspace"#,
            r#"D:\..\workspace"#,
            r#"D:\bad?name"#,
            r#"\\server"#,
            r#"\\server\share\..\workspace"#,
            "/../../home/developer",
            "D:\\bad\nname",
        ] {
            assert!(
                parse_project_folder_path(invalid).is_err(),
                "unexpectedly accepted: {invalid:?}"
            );
        }
        assert!(parse_project_folder_path(&"a".repeat(1025)).is_err());
    }

    #[test]
    fn adding_a_project_only_parses_the_path() {
        let unc = parse_project_folder(
            r#"\\wsl.localhost\Ubuntu\definitely-missing\project"#.to_string(),
        )
        .unwrap();
        assert_eq!(
            unc.path,
            r#"\\wsl.localhost\Ubuntu\definitely-missing\project"#
        );
        assert_eq!(unc.wsl_path, "/definitely-missing/project");
        assert_eq!(unc.wsl_distribution.as_deref(), Some("Ubuntu"));

        let drive = parse_project_folder(r#"Z:\definitely-missing\project"#.to_string()).unwrap();
        assert_eq!(drive.path, r#"Z:\definitely-missing\project"#);
        assert_eq!(drive.wsl_path, "/mnt/z/definitely-missing/project");
    }

    #[test]
    fn onecommander_candidates_cover_machine_user_and_path_installs() {
        let configured = PathBuf::from(r"D:\Tools\OneCommander\OneCommander.exe");
        let program_files = PathBuf::from(r"C:\Program Files");
        let local_app_data = PathBuf::from(r"C:\Users\tester\AppData\Local");
        let candidates = onecommander_candidate_paths(
            Some(&configured),
            &[program_files.clone(), program_files.clone()],
            Some(&local_app_data),
        );

        assert_eq!(candidates[0], configured);
        assert!(candidates.contains(&program_files.join("OneCommander").join("OneCommander.exe")));
        assert!(candidates.contains(
            &local_app_data
                .join("Programs")
                .join("OneCommander")
                .join("OneCommander.exe")
        ));
        assert_eq!(candidates.last().unwrap(), Path::new("OneCommander.exe"));
        assert_eq!(
            candidates
                .iter()
                .filter(|candidate| {
                    **candidate == program_files.join("OneCommander").join("OneCommander.exe")
                })
                .count(),
            1
        );
    }

    #[test]
    fn onecommander_receives_the_project_path_as_one_argument() {
        let executable = Path::new(r"C:\Program Files\OneCommander\OneCommander.exe");
        let project_path = r"\\wsl.localhost\Ubuntu\home\developer\中文 项目";
        let command = onecommander_command(executable, project_path);
        let arguments: Vec<_> = command.get_args().collect();

        assert_eq!(command.get_program(), executable.as_os_str());
        assert_eq!(arguments.len(), 1);
        assert_eq!(arguments[0], project_path);
    }

    #[test]
    fn onecommander_project_paths_use_windows_paths_and_convert_wsl_paths() {
        let windows_path =
            onecommander_project_path(r"D:\Workspace\中文 项目", None, |_, _| {
                panic!("Windows paths must not invoke WSL")
            })
            .unwrap();
        assert_eq!(windows_path, r"D:\Workspace\中文 项目");

        let wsl_path = onecommander_project_path(
            r"home\developer\project\中文 项目",
            Some("Ubuntu"),
            |path, distribution| {
                assert_eq!(path, "/home/developer/project/中文 项目");
                assert_eq!(distribution, Some("Ubuntu"));
                Ok(r"\\wsl.localhost\Ubuntu\home\developer\project\中文 项目".to_string())
            },
        )
        .unwrap();
        assert_eq!(
            wsl_path,
            r"\\wsl.localhost\Ubuntu\home\developer\project\中文 项目"
        );

        assert!(
            onecommander_project_path("/home/developer", Some("Ubuntu?"), |_, _| {
                panic!("an invalid distribution must not be passed to WSL")
            })
            .is_err()
        );
        assert!(onecommander_project_path("/home/developer", None, |_, _| {
            Ok("/still/a/wsl/path".to_string())
        })
        .is_err());
    }

    #[test]
    fn project_shell_cache_only_accepts_canonical_launch_targets() {
        let target =
            project_shell_target_from_cache("/home/developer/中文 项目", Some("Ubuntu-24.04"))
                .unwrap();
        assert_eq!(target.wsl_path, "/home/developer/中文 项目");
        assert_eq!(target.wsl_distribution.as_deref(), Some("Ubuntu-24.04"));
        assert!(project_shell_target_from_cache("/", None).is_ok());
        assert!(project_shell_target_from_cache("/~/project/win_edge/download", None).is_err());

        for invalid_path in [
            "home/developer/project",
            "/home/../etc",
            "/home/./project",
            "/home//project",
            "/home/project/",
            "/home\\project",
            "/home/\nproject",
        ] {
            assert!(
                project_shell_target_from_cache(invalid_path, None).is_err(),
                "unexpectedly accepted cached path: {invalid_path:?}"
            );
        }
        assert!(project_shell_target_from_cache(&format!("/{}", "a".repeat(1024)), None).is_err());

        for invalid_distribution in [
            "",
            " Ubuntu",
            "Ubuntu ",
            "Ubuntu/bad",
            "Ubuntu\\bad",
            "Ubuntu?",
        ] {
            assert!(
                project_shell_target_from_cache("/home/developer", Some(invalid_distribution))
                    .is_err(),
                "unexpectedly accepted cached distribution: {invalid_distribution:?}"
            );
        }
    }

    #[test]
    fn terminal_help_matches_the_platform_shell() {
        let help = terminal_help_text();

        #[cfg(target_os = "windows")]
        {
            assert!(help.contains("WSL"));
            assert!(help.contains("pwd"));
            assert!(!help.contains("20 秒"));
        }

        #[cfg(not(target_os = "windows"))]
        {
            assert!(help.contains("pwd"));
            assert!(help.contains("20 秒"));
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_project_folder_expands_the_default_wsl_home() {
        let home = current_wsl_home_directory().unwrap();
        let resolved =
            parse_project_folder_for_current_platform("~/project/win_edge/download").unwrap();

        assert_eq!(
            resolved.wsl_path,
            format!("{}/project/win_edge/download", home.trim_end_matches('/'))
        );
        assert!(!resolved.wsl_path.contains('~'));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_wsl_terminal_command_preserves_utf8_output() {
        let (text, exit_code, success) =
            run_terminal_command("printf '中文输出正常\\n'", &terminal_working_directory());

        assert!(success, "WSL command failed: {text}");
        assert_eq!(exit_code, Some(0));
        assert!(text.contains("中文输出正常"), "unexpected output: {text}");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_pty_uses_the_unc_distribution_and_passes_cwd_as_one_argument() {
        let mut candidates = pty_shell_candidates();

        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].0, "WSL");
        assert_eq!(candidates[0].1.get_argv()[0].to_string_lossy(), "wsl.exe");

        let target =
            project_shell_target_from_cache("/home/developer/中文 项目", Some("Ubuntu")).unwrap();
        configure_pty_command(&mut candidates[0].1, Some(&target));
        let arguments = candidates[0].1.get_argv();
        assert_eq!(arguments[1].to_string_lossy(), "--distribution");
        assert_eq!(arguments[2].to_string_lossy(), "Ubuntu");
        assert_eq!(arguments[3].to_string_lossy(), "--cd");
        assert_eq!(arguments[4].to_string_lossy(), "/home/developer/中文 项目");
    }

    #[test]
    fn state_snapshot_read_and_presence_changes_stay_consistent() {
        let mut store = ChatStore::demo();
        assert_eq!(store.contact("linxia").unwrap().unread_count, 2);

        let contact = store.mark_read("linxia").unwrap();
        assert_eq!(contact.unread_count, 0);
        assert_eq!(store.active_contact_id, "linxia");
        assert!(store
            .conversation("linxia")
            .unwrap()
            .iter()
            .all(|message| message.outgoing || message.read));

        let current_user = store.set_presence(" Away ").unwrap();
        assert_eq!(current_user.presence, "away");
        assert!(store.set_presence("sleeping").is_err());

        let snapshot = store.snapshot();
        assert_eq!(snapshot.current_user.presence, "away");
        assert_eq!(snapshot.contacts.len(), 6);
        assert_eq!(snapshot.active_contact_id, "linxia");
    }

    #[test]
    fn project_store_roundtrips_through_json() {
        let store = ProjectStoreFile {
            directories: vec![ProjectDirectoryRecord {
                id: "dir-1".into(),
                name: "项目文件夹".into(),
            }],
            folders: vec![ProjectFolderRecord {
                id: "p-1".into(),
                directory_id: "dir-1".into(),
                name: "demo".into(),
                path: "\\\\wsl.localhost\\Ubuntu\\home\\beluga\\demo".into(),
                wsl_path: Some("/home/beluga/demo".into()),
                wsl_distribution: Some("Ubuntu".into()),
            }],
        };
        let json = serde_json::to_string(&store).unwrap();
        assert!(json.contains("\"directoryId\""));
        assert!(json.contains("\"wslPath\""));
        assert!(json.contains("\"wslDistribution\""));
        let parsed: ProjectStoreFile = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, store);
    }

    #[test]
    fn project_store_tolerates_missing_optional_fields() {
        let parsed: ProjectStoreFile = serde_json::from_str(
            r#"{"directories":[{"id":"d","name":"目录"}],"folders":[{"id":"f","directoryId":"d","name":"p","path":"C:\\work"}]}"#,
        )
        .unwrap();
        assert_eq!(parsed.folders.len(), 1);
        assert_eq!(parsed.folders[0].wsl_path, None);
        assert_eq!(parsed.folders[0].wsl_distribution, None);
        let serialized = serde_json::to_string(&parsed).unwrap();
        assert!(!serialized.contains("wslPath"));
        assert!(!serialized.contains("wslDistribution"));
        let empty: ProjectStoreFile = serde_json::from_str("{}").unwrap();
        assert!(empty.directories.is_empty());
        assert!(empty.folders.is_empty());
    }
}
