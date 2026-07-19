package com.yuejian.reader;

import android.app.job.JobParameters;
import android.app.job.JobService;

import org.json.JSONObject;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Network-constrained sync that survives activity destruction without extra app permissions. */
public final class SyncJobService extends JobService {
    static final int JOB_ID = 0x59554A53;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    @Override public boolean onStartJob(JobParameters parameters) {
        executor.execute(() -> {
            boolean retry = false;
            AccountStore account = new AccountStore(getApplicationContext());
            if (account.accountMode()) {
                try (BookRepository repository = new BookRepository(getApplicationContext())) {
                    JSONObject result = new SyncManager(repository, account).syncNow();
                    retry = !result.optBoolean("ok");
                } catch (Exception error) {
                    account.failed(SyncManager.friendlyMessage(error));
                    retry = true;
                }
            }
            jobFinished(parameters, retry);
        });
        return true;
    }

    @Override public boolean onStopJob(JobParameters parameters) {
        return true;
    }

    @Override public void onDestroy() {
        executor.shutdownNow();
        super.onDestroy();
    }
}
